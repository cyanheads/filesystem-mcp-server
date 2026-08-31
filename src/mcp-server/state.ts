import path from 'path';
import fs from 'fs';
import { config } from '../config/index.js';
import { BaseErrorCode, McpError } from '../types-global/errors.js';
import { logger } from '../utils/internal/logger.js';
import { RequestContext, requestContextService } from '../utils/internal/requestContext.js';
import { sanitization } from '../utils/security/sanitization.js';

/**
 * Simple in-memory state management for the MCP server session.
 * This state is cleared when the server restarts.
 */
class ServerState {
  private defaultFilesystemPath: string | null = null;
  private fsBaseDirectory: string | null = null;

  constructor() {
    this.fsBaseDirectory = config.fsBaseDirectory || null;
    if (this.fsBaseDirectory) {
      // Ensure fsBaseDirectory itself is sanitized and absolute for internal use
      const initContext = requestContextService.createRequestContext({ operation: 'ServerStateInit' });
      try {
        const sanitizedBase = sanitization.sanitizePath(this.fsBaseDirectory, { allowAbsolute: true, toPosix: true });
        this.fsBaseDirectory = sanitizedBase.sanitizedPath;
        logger.info(`Filesystem operations will be restricted to base directory: ${this.fsBaseDirectory}`, initContext);
      } catch (error) {
        logger.error(`Invalid FS_BASE_DIRECTORY configured: ${this.fsBaseDirectory}. It will be ignored.`, { ...initContext, error: error instanceof Error ? error.message : String(error) });
        this.fsBaseDirectory = null; // Disable if invalid
      }
    }
  }

  /**
   * Sets the default filesystem path for the current session.
   * The path is sanitized and validated.
   *
   * @param newPath - The absolute path to set as default.
   * @param context - The request context for logging.
   * @throws {McpError} If the path is invalid or not absolute.
   */
  setDefaultFilesystemPath(newPath: string, context: RequestContext): void {
    logger.debug(`Attempting to set default filesystem path: ${newPath}`, context);
    try {
      // Ensure the path is absolute before storing
      if (!path.isAbsolute(newPath)) {
         throw new McpError(BaseErrorCode.VALIDATION_ERROR, 'Default path must be absolute.', { ...context, path: newPath });
      }
      // Sanitize the absolute path (mainly for normalization and basic checks)
      // We don't restrict to a rootDir here as it's a user-provided default.
      const sanitizedPathInfo = sanitization.sanitizePath(newPath, { allowAbsolute: true, toPosix: true });

      this.defaultFilesystemPath = sanitizedPathInfo.sanitizedPath;
      logger.info(`Default filesystem path set to: ${this.defaultFilesystemPath}`, context);
    } catch (error) {
      logger.error(`Failed to set default filesystem path: ${newPath}`, { ...context, error: error instanceof Error ? error.message : String(error) });
      // Rethrow McpError or wrap other errors
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Invalid default path provided: ${error instanceof Error ? error.message : String(error)}`, { ...context, path: newPath, originalError: error });
    }
  }

  /**
   * Gets the currently set default filesystem path.
   *
   * @returns The absolute default path or null if not set.
   */
  getDefaultFilesystemPath(): string | null {
    return this.defaultFilesystemPath;
  }

  /**
   * Clears the default filesystem path.
   * @param context - The request context for logging.
   */
  clearDefaultFilesystemPath(context: RequestContext): void {
    logger.info('Clearing default filesystem path.', context);
    this.defaultFilesystemPath = null;
  }

  /**
   * Resolves a given path against the default path if the given path is relative.
   * If the given path is absolute, it's returned directly after sanitization.
   * If the given path is relative and no default path is set, an error is thrown.
   *
   * @param requestedPath - The path provided by the user (can be relative or absolute).
   * @param context - The request context for logging and error handling.
   * @returns The resolved, sanitized, absolute path.
   * @throws {McpError} If a relative path is given without a default path set, or if sanitization fails.
   */
  resolvePath(requestedPath: string, context: RequestContext): string {
    logger.debug(`Resolving path: ${requestedPath}`, { ...context, defaultPath: this.defaultFilesystemPath, fsBaseDirectory: this.fsBaseDirectory });

    let absolutePath: string;

    if (path.isAbsolute(requestedPath)) {
      absolutePath = requestedPath;
      logger.debug('Provided path is absolute.', { ...context, path: absolutePath });
    } else {
      if (!this.defaultFilesystemPath) {
        logger.warning('Relative path provided but no default path is set.', { ...context, path: requestedPath });
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          'Relative path provided, but no default filesystem path has been set for this session. Please provide an absolute path or set a default path first.',
          { ...context, path: requestedPath }
        );
      }
      absolutePath = path.join(this.defaultFilesystemPath, requestedPath);
      logger.debug(`Resolved relative path against default: ${absolutePath}`, { ...context, relativePath: requestedPath, defaultPath: this.defaultFilesystemPath });
    }
    
    let sanitizedAbsolutePath: string;
    try {
      // Sanitize the path first. allowAbsolute is true as we've resolved it.
      // No rootDir is enforced by sanitizePath itself here; boundary check is next.
      const sanitizedPathInfo = sanitization.sanitizePath(absolutePath, { allowAbsolute: true, toPosix: true });
      sanitizedAbsolutePath = sanitizedPathInfo.sanitizedPath;
      logger.debug(`Sanitized resolved path: ${sanitizedAbsolutePath}`, { ...context, originalPath: absolutePath });
    } catch (error) {
       logger.error(`Failed to sanitize resolved path: ${absolutePath}`, { ...context, error: error instanceof Error ? error.message : String(error) });
       if (error instanceof McpError) {
         throw error; // Rethrow validation errors from sanitizePath
       }
       throw new McpError(BaseErrorCode.INTERNAL_ERROR, `Failed to process path: ${error instanceof Error ? error.message : String(error)}`, { ...context, path: absolutePath, originalError: error });
    }

    // Enforce FS_BASE_DIRECTORY boundary if it's set
    if (this.fsBaseDirectory) {
      // Normalize both paths for a reliable comparison
      const normalizedFsBaseDirectory = path.normalize(this.fsBaseDirectory);
      const normalizedSanitizedAbsolutePath = path.normalize(sanitizedAbsolutePath);

      // Check if the sanitized absolute path is within the base directory
      if (!normalizedSanitizedAbsolutePath.startsWith(normalizedFsBaseDirectory + path.sep) && normalizedSanitizedAbsolutePath !== normalizedFsBaseDirectory) {
        logger.error(
          `Path access violation: Attempted to access path "${sanitizedAbsolutePath}" which is outside the configured FS_BASE_DIRECTORY "${this.fsBaseDirectory}".`,
          { ...context, requestedPath, resolvedPath: sanitizedAbsolutePath, fsBaseDirectory: this.fsBaseDirectory }
        );
        throw new McpError(
          BaseErrorCode.FORBIDDEN,
          `Access denied: The path "${requestedPath}" resolves to a location outside the allowed base directory.`,
          { ...context, requestedPath, resolvedPath: sanitizedAbsolutePath }
        );
      }
      // --- Fix (issue #21): enforce symlink containment with realpath resolution ---
      // The lexical startsWith check above can be bypassed by a symlink located
      // INSIDE the base dir that points OUTSIDE it (Node fs follows symlinks).
      // Resolve the *real* target (and the base) and re-verify confinement.
      try {
        const realBaseDir = fs.realpathSync.native(normalizedFsBaseDirectory);
        let realTarget = sanitizedAbsolutePath;
        // If the exact target doesn't exist yet (e.g. writeFile to a new path),
        // the tool will create it; verify its parent's real location instead.
        try {
          realTarget = fs.realpathSync.native(normalizedSanitizedAbsolutePath);
        } catch {
          const parent = path.dirname(normalizedSanitizedAbsolutePath);
          realTarget = path.join(fs.realpathSync.native(parent), path.basename(normalizedSanitizedAbsolutePath));
        }
        const realSep = path.sep;
        const withinReal =
          realTarget.startsWith(realBaseDir + realSep) || realTarget === realBaseDir;
        if (!withinReal) {
          const realBaseStripped = realBaseDir.replace(/\/$/, "");
          logger.error(
            `Symlink escape blocked: resolved target \"${realTarget}\" escapes FS_BASE_DIRECTORY realpath \"${realBaseStripped}\".`,
            { ...context, requestedPath, resolvedRealPath: realTarget }
          );
          throw new McpError(
            BaseErrorCode.FORBIDDEN,
            `Access denied: The path \"${requestedPath}\" resolves (via symlink) to a location outside the allowed base directory.`,
            { ...context, requestedPath, resolvedRealPath: realTarget }
          );
        }
      } catch (error) {
        if (error instanceof McpError) throw error;
        // realpath unavailable (fs.lstat on a broken symlink, etc.) — rethrow as internal.
        throw new McpError(
          BaseErrorCode.INTERNAL_ERROR,
          `Failed to verify path containment: ${error instanceof Error ? error.message : String(error)}`,
          { ...context, requestedPath }
        );
      }
      logger.debug(`Path is within FS_BASE_DIRECTORY: ${sanitizedAbsolutePath}`, context);
    }

    return sanitizedAbsolutePath;
  }
}

// Export a singleton instance
export const serverState = new ServerState();
