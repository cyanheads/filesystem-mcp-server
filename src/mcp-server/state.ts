import path from 'path';
import { existsSync, statSync } from 'fs';
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

  constructor(skipLogging: boolean = false) {
    this.fsBaseDirectory = config.fsBaseDirectory || null;
    if (this.fsBaseDirectory) {
      // Ensure fsBaseDirectory itself is sanitized and absolute for internal use
      const initContext = requestContextService.createRequestContext({ operation: 'ServerStateInit' });
      try {
        const sanitizedBase = sanitization.sanitizePath(this.fsBaseDirectory, { allowAbsolute: true, toPosix: true });
        this.fsBaseDirectory = sanitizedBase.sanitizedPath;
        if (!skipLogging) {
          logger.info(`Filesystem operations will be restricted to base directory: ${this.fsBaseDirectory}`, initContext);
        }
      } catch (error) {
        if (!skipLogging) {
          logger.error(`Invalid FS_BASE_DIRECTORY configured: ${this.fsBaseDirectory}. It will be ignored.`, { ...initContext, error: error instanceof Error ? error.message : String(error) });
        }
        this.fsBaseDirectory = null; // Disable if invalid
      }
    }

    // Initialize default filesystem path if configured
    if (config.fsDefaultDirectory) {
      const initContext = requestContextService.createRequestContext({ operation: 'ServerStateInit' });
      try {
        this.initializeDefaultFilesystemPath(config.fsDefaultDirectory, initContext, skipLogging);
      } catch (error) {
        if (!skipLogging) {
          logger.error(`Failed to initialize default filesystem path from config: ${config.fsDefaultDirectory}`, { ...initContext, error: error instanceof Error ? error.message : String(error) });
        }
        // Don't throw here, just log the error and continue without default path
      }
    }
  }

  /**
   * Sets the default filesystem path for the current session.
   * The path is sanitized and validated.
   *
   * @param newPath - The absolute path to set as default.
   * @param context - The request context for logging.
   * @throws {McpError} If the path is invalid, not absolute, doesn't exist, is not a directory, or is outside FS_BASE_DIRECTORY scope.
   */
  setDefaultFilesystemPath(newPath: string, context: RequestContext): void {
    logger.debug(`Attempting to set default filesystem path: ${newPath}`, context);
    try {
      // Ensure the path is absolute before storing
      if (!path.isAbsolute(newPath)) {
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, 'Default path must be absolute.', { ...context, path: newPath });
      }

      // Check if the path exists
      if (!existsSync(newPath)) {
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, 'Default path does not exist.', { ...context, path: newPath });
      }

      // Check if it's a directory
      const stats = statSync(newPath);
      if (!stats.isDirectory()) {
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, 'Default path must be a directory.', { ...context, path: newPath });
      }

      // If FS_BASE_DIRECTORY is set, ensure the path is within scope
      if (this.fsBaseDirectory) {
        const normalizedFsBaseDirectory = path.normalize(this.fsBaseDirectory);
        const normalizedNewPath = path.normalize(newPath);

        if (!normalizedNewPath.startsWith(normalizedFsBaseDirectory + path.sep) && normalizedNewPath !== normalizedFsBaseDirectory) {
          throw new McpError(BaseErrorCode.FORBIDDEN, `Default path must be within the configured FS_BASE_DIRECTORY scope: ${this.fsBaseDirectory}`, { ...context, path: newPath, fsBaseDirectory: this.fsBaseDirectory });
        }
      }

      // Sanitize the absolute path (mainly for normalization and basic checks)
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
   * Gets the configured FS_BASE_DIRECTORY.
   *
   * @returns The absolute base directory path or null if not set.
   */
  getFsBaseDirectory(): string | null {
    return this.fsBaseDirectory;
  }

  /**
   * Initializes the default filesystem path at server startup.
   * This method can be called during server initialization to set an initial default path.
   * Uses the same validation as setDefaultFilesystemPath.
   *
   * @param initialPath - The absolute path to set as initial default.
   * @param context - The request context for logging.
   * @param skipLogging - Whether to skip logging (used during early initialization).
   * @throws {McpError} If the path is invalid, doesn't exist, etc.
   */
  initializeDefaultFilesystemPath(initialPath: string, context: RequestContext, skipLogging: boolean = false): void {
    if (this.defaultFilesystemPath !== null) {
      if (!skipLogging) {
        logger.warning('Default filesystem path already set, skipping initialization.', context);
      }
      return;
    }

    if (!skipLogging) {
      logger.info(`Initializing default filesystem path at startup: ${initialPath}`, context);
    }
    this.setDefaultFilesystemPath(initialPath, context);
  }

  /**
   * Re-initializes the ServerState with logging enabled after logger is ready.
   * This is called after logger initialization to log configuration that was skipped earlier.
   *
   * @param context - The request context for logging.
   */
  reinitializeWithLogging(context: RequestContext): void {
    if (this.fsBaseDirectory) {
      logger.info(`Filesystem operations will be restricted to base directory: ${this.fsBaseDirectory}`, context);
    }

    if (config.fsDefaultDirectory && this.defaultFilesystemPath) {
      logger.info(`Default filesystem path initialized at startup: ${this.defaultFilesystemPath}`, context);
    }
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
    let wasAbsolute = path.isAbsolute(requestedPath);

    if (this.defaultFilesystemPath) {
      // When default is set, treat all paths as relative to default, stripping leading '/' if present
      let relativePath = requestedPath;
      if (relativePath.startsWith('/')) {
        relativePath = relativePath.slice(1);
        wasAbsolute = false; // Treat as relative for boundary checks
      }
      absolutePath = path.join(this.defaultFilesystemPath, relativePath);
      logger.debug(`Resolved path against default: ${absolutePath}`, { ...context, requestedPath, relativePath, defaultPath: this.defaultFilesystemPath });
    } else {
      if (wasAbsolute) {
        absolutePath = requestedPath;
        logger.debug('Provided path is absolute.', { ...context, path: absolutePath });
      } else {
        logger.warning('Relative path provided but no default path is set.', { ...context, path: requestedPath });
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          'Relative path provided, but no default filesystem path has been set for this session. Please provide an absolute path or set a default path first.',
          { ...context, path: requestedPath }
        );
      }
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

    // Enforce FS_BASE_DIRECTORY boundary if it's set and the path was relative
    if (this.fsBaseDirectory && !wasAbsolute) {
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
      logger.debug(`Path is within FS_BASE_DIRECTORY: ${sanitizedAbsolutePath}`, context);
    }

    return sanitizedAbsolutePath;
  }
}

// Export a singleton instance
// Note: Created with skipLogging=true to avoid logger errors during early initialization.
// Logger will be properly initialized later in the startup sequence.
export const serverState = new ServerState(true);
