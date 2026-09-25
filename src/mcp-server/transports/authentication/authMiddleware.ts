/**
 * @fileoverview MCP Authentication Middleware for Bearer Token Validation (JWT).
 *
 * This middleware validates JSON Web Tokens (JWT) passed via the 'Authorization' header
 * using the 'Bearer' scheme (e.g., "Authorization: Bearer <your_token>").
 * It verifies the token's signature and expiration using the secret key defined
 * in the configuration (`config.mcpAuthSecretKey`).
 *
 * If the token is valid, an object conforming to the MCP SDK's `AuthInfo` type
 * (expected to contain `token`, `clientId`, and `scopes`) is attached to `req.auth`.
 * If the token is missing, invalid, or expired, it sends an HTTP 401 Unauthorized response.
 *
 * @see {@link https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/authorization.mdx | MCP Authorization Specification}
 * @module src/mcp-server/transports/authentication/authMiddleware
 */

import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"; // Import from SDK
import { NextFunction, Request, Response } from "express";
import { createVerifier, type VerifierOptions, type KeyFetcher, JwtHeader, Bufferable, DecodedJwt } from 'fast-jwt';
import jwksClient from "jwks-rsa";
import { config, environment } from "../../../config/index.js";
import { logger, requestContextService } from "../../../utils/index.js";

// Extend the Express Request interface to include the optional 'auth' property
// using the imported AuthInfo type from the SDK.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Authentication information derived from the JWT, conforming to MCP SDK's AuthInfo. */
      auth?: AuthInfo;
    }
  }
}

// Startup Validation: Validate secret key presence on module load.
if (environment === "production" && !config.mcpAuthSecretKey) {
  const error = new Error(
    "CRITICAL: MCP_AUTH_SECRET_KEY must be set in production environment for JWT authentication."
  );
  logger.fatal(
    "CRITICAL: MCP_AUTH_SECRET_KEY is not set in production environment. Authentication cannot proceed securely.",
  );
  // Force process exit in production to prevent insecure startup
  process.exit(1);
} else if (!config.mcpAuthSecretKey) {
  logger.warning(
    "MCP_AUTH_SECRET_KEY is not set. Authentication middleware will bypass checks (DEVELOPMENT ONLY). This is insecure for production.",
  );
}

const JWT_AUDIENCE = process.env.MCP_JWT_AUDIENCE as string | undefined;
const JWT_ISSUER = process.env.MCP_JWT_ISSUER as string | undefined;
const JWT_URI = process.env.MCP_JWKS_URI as string | undefined;

interface JwtPayload {
  sub: string;
  email?: string;
  iat?: number;
  exp?: number;
  iss?: string;
  cid?: string;
  client_id?: string;
  scp?: string;
  scope?: string;
  aud?: string | string[];
  [key: string]: unknown;
}

const client = jwksClient({
  jwksUri: JWT_URI!,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

async function getKey(header: { kid?: string; alg?: string, aud?: string, iss?: string}): Promise<string> {
  if (!header.kid) {
    throw new Error('No "kid" in token header');
  }
  
  const key = await client.getSigningKey(header.kid);
  const signingKey = key.getPublicKey();

  if (!signingKey) {
    throw new Error('Unable to get signing key');
  }

  return signingKey;
}

const keyFetcher: KeyFetcher = async (decodeJwt: DecodedJwt) => {
  if (!decodeJwt.header.kid) {
    throw new Error('No "kid" in token header');
  }

  return await getKey(decodeJwt.header) as Bufferable;
};

const verifierOptions: Partial<VerifierOptions> & { key: KeyFetcher } = {
  algorithms: ['RS256'],
  allowedAud: JWT_AUDIENCE,
  allowedIss: JWT_ISSUER,
  key: keyFetcher,
};

const verifyJwtAsync = createVerifier(verifierOptions);

async function verifyToken(token: string): Promise<JwtPayload> {
  try
  {
    const payload = await verifyJwtAsync(token);
    return payload as JwtPayload;
  } catch (error: unknown) {
    throw error;
  }
}

/**
 * Express middleware for verifying JWT Bearer token authentication.
 */
export async function mcpAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const context = requestContextService.createRequestContext({
    operation: "mcpAuthMiddleware",
    method: req.method,
    path: req.path,
  });
  logger.debug(
    "Running MCP Authentication Middleware (Bearer Token Validation)...",
    context,
  );

  // Development Mode Bypass
  if (!config.mcpAuthSecretKey) {
    if (environment !== "production") {
      logger.warning(
        "Bypassing JWT authentication: MCP_AUTH_SECRET_KEY is not set (DEVELOPMENT ONLY).",
        context,
      );
      // Populate req.auth strictly according to SDK's AuthInfo
      req.auth = {
        token: "dev-mode-placeholder-token",
        clientId: "dev-client-id",
        scopes: ["dev-scope"],
      };
      // Log dev mode details separately, not attaching to req.auth if not part of AuthInfo
      logger.debug("Dev mode auth object created.", {
        ...context,
        authDetails: req.auth,
      });
      return next();
    } else {
      logger.error(
        "FATAL: MCP_AUTH_SECRET_KEY is missing in production. Cannot bypass auth.",
        context,
      );
      res.status(500).json({
        error: "Server configuration error: Authentication key missing.",
      });
      return;
    }
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warning(
      "Authentication failed: Missing or malformed Authorization header (Bearer scheme required).",
      context,
    );
    res.status(401).json({
      error: "Unauthorized: Missing or invalid authentication token format.",
    });
    return;
  }

  const tokenParts = authHeader.split(" ");
  if (tokenParts.length !== 2 || tokenParts[0] !== "Bearer" || !tokenParts[1]) {
    logger.warning("Authentication failed: Malformed Bearer token.", context);
    res
      .status(401)
      .json({ error: "Unauthorized: Malformed authentication token." });
    return;
  }
  const rawToken = tokenParts[1];

  try {
    const decoded = await verifyToken(rawToken);

    if (typeof decoded === "string") {
      logger.warning(
        "Authentication failed: JWT decoded to a string, expected an object payload.",
        context,
      );
      res
        .status(401)
        .json({ error: "Unauthorized: Invalid token payload format." });
      return;
    }

    const appid = decoded.appid
    // Extract and validate fields for SDK's AuthInfo
    const clientIdFromToken =
      typeof appid === "string"
        ? appid
        : undefined;
    if (!clientIdFromToken) {
      logger.warning(
        "Authentication failed: JWT 'appid' claim is missing or not a string.",
        { ...context, jwtPayloadKeys: Object.keys(decoded) },
      );
      res.status(401).json({
        error: "Unauthorized: Invalid token, missing app identifier.",
      });
      return;
    }

    const scope = decoded.scp ?? decoded.scope;
    let scopesFromToken: string[];
    if (
      Array.isArray(scope) &&
      scope.every((s: unknown) => typeof s === "string")
    ) {
      scopesFromToken = scope as string[];
    } else if (
      typeof scope === "string" &&
      scope.trim() !== ""
    ) {
      scopesFromToken = scope.split(" ").filter((s: string) => s);
      if (scopesFromToken.length === 0 && scope.trim() !== "") {
        // handles case " " -> [""]
        scopesFromToken = [scope.trim()];
      } else if (scopesFromToken.length === 0 && scope.trim() === "") {
        // If scope is an empty string, treat as no scopes rather than erroring, or use a default.
        // Depending on strictness, could also error here. For now, allow empty array if scope was empty string.
        logger.debug(
          "JWT 'scope' claim was an empty string, resulting in empty scopes array.",
          context,
        );
      }
    } else {
      // If scopes are strictly mandatory and not found or invalid format
      logger.warning(
        "Authentication failed: JWT 'scp' or 'scope' claim is missing, not an array of strings, or not a valid space-separated string. Assigning default empty array.",
        { ...context, jwtPayloadKeys: Object.keys(decoded) },
      );
      scopesFromToken = []; // Default to empty array if scopes are mandatory but not found/invalid
      // Or, if truly mandatory and must be non-empty:
      // res.status(401).json({ error: "Unauthorized: Invalid token, missing or invalid scopes." });
      // return;
    }

    // Construct req.auth with only the properties defined in SDK's AuthInfo
    // All other claims from 'decoded' are not part of req.auth for type safety.
    req.auth = {
      token: rawToken,
      clientId: clientIdFromToken,
      scopes: scopesFromToken,
    };

    // Log separately if other JWT claims like 'sub' (sessionId) are needed for app logic
    const subClaimForLogging =
      typeof decoded.sub  === "string" ? decoded.sub  : undefined;
    logger.debug("JWT verified successfully. AuthInfo attached to request.", {
      ...context,
      mcpSessionIdContext: subClaimForLogging,
      clientId: req.auth.clientId,
      scopes: req.auth.scopes,
    });
    next();
  } catch (error: unknown) {
    let errorMessage = "Invalid token";
    // Removed specific handling of token error or expiration. Consider adding it back in.
    if (error instanceof Error) { // Catch other generic Errors
      errorMessage = `Verification error: ${error.message}`; // Accessing error.message safely
      logger.error(
        "Authentication failed: Unexpected error during token verification.",
        { ...context, error: error.message },
      );
    } else { // Handle truly unknown types
      errorMessage = "Unknown verification error";
      logger.error(
        "Authentication failed: Unexpected non-error exception during token verification.",
        { ...context, error: String(error) }, // Convert unknown error to string for logging
      );
    }
    res.status(401).json({ error: `Unauthorized: ${errorMessage}.` });
  }
}
