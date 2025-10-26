/**
 * @fileoverview Streamable HTTP MCP transport implementation.
 * No security checks, no origin validation, no JWT. Just pure MCP HTTP transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response } from "express";
import http from "http";
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { logger, requestContextService } from "../../utils/internal/index.js";
import { RequestContext } from "../../utils/internal/requestContext.js";
import { mcpAuthMiddleware } from "./authentication/authMiddleware.js";

const MCP_ENDPOINT_PATH = "/mcp";
const MAX_PORT_RETRIES = 15;
const httpTransports: Record<string, StreamableHTTPServerTransport> = {};

async function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    tempServer
      .once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "EADDRINUSE");
      })
      .once("listening", () => {
        tempServer.close(() => resolve(false));
      })
      .listen(port, host);
  });
}

function startHttpServerWithRetry(
  serverInstance: http.Server,
  initialPort: number,
  host: string,
  maxRetries: number,
  parentContext: RequestContext,
): Promise<number> {
  const startContext = requestContextService.createRequestContext({
    ...parentContext,
    operation: "startHttpServerWithRetry",
    initialPort,
    host,
    maxRetries,
  });
  logger.debug(`Attempting to start HTTP server...`, startContext);
  return new Promise(async (resolve, reject) => {
    let lastError: Error | null = null;
    for (let i = 0; i <= maxRetries; i++) {
      const currentPort = initialPort + i;
      const attemptContext = requestContextService.createRequestContext({
        ...startContext,
        port: currentPort,
        attempt: i + 1,
        maxAttempts: maxRetries + 1,
      });

      if (await isPortInUse(currentPort, host)) {
        lastError = new Error(`Port ${currentPort} is in use.`);
        await new Promise((res) => setTimeout(res, 100));
        continue;
      }

      try {
        await new Promise<void>((listenResolve, listenReject) => {
          serverInstance
            .listen(currentPort, host, () => {
              const serverAddress = `http://${host}:${currentPort}${MCP_ENDPOINT_PATH}`;
              logger.info(`HTTP transport listening at ${serverAddress}`, {
                ...attemptContext,
                address: serverAddress,
              });
              listenResolve();
            })
            .on("error", (err: NodeJS.ErrnoException) => {
              listenReject(err);
            });
        });
        resolve(currentPort);
        return;
      } catch (err: any) {
        lastError = err;
        if (err.code === "EADDRINUSE") {
          await new Promise((res) => setTimeout(res, 100));
        } else {
          reject(err);
          return;
        }
      }
    }
    reject(
      lastError ||
      new Error("Failed to bind to any port after multiple retries."),
    );
  });
}

export async function startHttpTransport(
  createServerInstanceFn: () => Promise<McpServer>,
  parentContext: RequestContext,
): Promise<void> {
  const app = express();
  const transportContext = requestContextService.createRequestContext({
    ...parentContext,
    transportType: "HTTP",
    component: "HttpTransportSetup",
  });

  app.use(express.json());

  // JWT Authentication middleware
  app.use(mcpAuthMiddleware);

  // Handle POST requests for client-to-server communication
  app.post(MCP_ENDPOINT_PATH, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    try {
      if (sessionId && httpTransports[sessionId]) {
        // Reuse existing transport
        transport = httpTransports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            httpTransports[newSessionId] = transport;
            logger.info(
              `HTTP Session created: ${newSessionId}`,
              transportContext,
            );
          },
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId) {
            delete httpTransports[transport.sessionId];
            logger.info(
              `HTTP Session closed: ${transport.sessionId}`,
              transportContext,
            );
          }
        };

        const server = await createServerInstanceFn();
        await server.connect(transport);
      } else {
        // Invalid request
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      // Handle the request
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("Error handling POST request", {
        ...transportContext,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  // Handle GET requests for server-to-client notifications via SSE
  app.get(MCP_ENDPOINT_PATH, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !httpTransports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const transport = httpTransports[sessionId];
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error("Error handling GET request", {
        ...transportContext,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  // Handle DELETE requests for session termination
  app.delete(MCP_ENDPOINT_PATH, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !httpTransports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const transport = httpTransports[sessionId];
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error("Error handling DELETE request", {
        ...transportContext,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  const serverInstance = http.createServer(app);
  try {
    const actualPort = await startHttpServerWithRetry(
      serverInstance,
      config.mcpHttpPort,
      config.mcpHttpHost,
      MAX_PORT_RETRIES,
      transportContext,
    );

    const serverAddressLog = `http://${config.mcpHttpHost}:${actualPort}${MCP_ENDPOINT_PATH}`;
    if (process.stdout.isTTY) {
      console.log(
        `\n🚀 MCP Server running in HTTP mode at: ${serverAddressLog}\n   (MCP Spec: 2025-03-26 Streamable HTTP Transport)\n`,
      );
    }
  } catch (err) {
    logger.fatal("HTTP server failed to start after multiple port retries.", {
      ...transportContext,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}