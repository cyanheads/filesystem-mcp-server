# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **JWT Token Generation Script**: New `scripts/generate-jwt.js` script to generate JWT tokens for HTTP transport authentication. Usage: `npm run generate-jwt`.

### Changed
- **Path Resolution**: Modified `resolvePath` in `src/mcp-server/state.ts` to treat paths starting with `/` as relative to the default filesystem path when one is set, allowing both `Desktop` and `/Desktop` to resolve to the same location.
- **get_filesystem_info Tool Output Fields**: Renamed output fields for clarity:
  - `currentDefaultPath` → `currentWorkingDirectory` (represents the current working directory for relative path resolution)
  - `fsBaseDirectory` → `filesystemScopeRestriction` (represents the filesystem scope restriction if configured)
- **HTTP Transport**: Removed origin validation feature (MCP_ALLOWED_ORIGINS). HTTP transport now provides streamable MCP communication without CORS origin checking. Authentication is still available via JWT (MCP_AUTH_SECRET_KEY).
- **Logger Initialization**: Fixed "Logger not initialized; message dropped" errors by:
  - Deferring detailed logging of ServerState initialization until after logger is ready
  - Added `skipLogging` parameter to ServerState constructor for early initialization
  - Added `reinitializeWithLogging()` method to log configuration after logger initialization in `src/index.ts`
  - This ensures all logging messages are properly captured from server startup

### Fixed
- Logger initialization timing issue where ServerState configuration logs were dropped during early startup

## [1.0.4] - 2025-05-23

### Changed
- **Configuration**: `FS_BASE_DIRECTORY` can now be set as a path relative to the project root (e.g., `./data_sandbox`) in addition to an absolute path. The server will resolve relative paths to an absolute path. If the directory doesn't exist, it will be created. This feature remains optional, with a warning logged if `FS_BASE_DIRECTORY` is not set.
  - Updated `src/config/index.ts` to handle relative path resolution for `FS_BASE_DIRECTORY`.
  - Updated `README.md` to reflect this new flexibility.

## [1.0.3] - 2025-05-23

### Added

- **Filesystem Access Control**: Introduced `FS_BASE_DIRECTORY` environment variable. If set to an absolute path, all filesystem tool operations are restricted to this directory and its subdirectories, enhancing security by preventing unintended access to other parts of the filesystem.
  - Configuration (`src/config/index.ts`) updated to include `FS_BASE_DIRECTORY`, with validation ensuring it's an absolute path if provided.
  - Server state (`src/mcp-server/state.ts`) now initializes and enforces this base directory. The `resolvePath` method checks if the resolved path is within the `FS_BASE_DIRECTORY` and throws a `FORBIDDEN` error if it's outside.
  - Dockerfile updated to include `FS_BASE_DIRECTORY` as a build argument and environment variable.
  - `mcp.json` and `smithery.yaml` updated to include `FS_BASE_DIRECTORY`.

### Changed

- **Version Bump**: Project version updated to `1.0.3` in `package.json`, `README.md`.
- **Documentation**:
  - `README.md` updated to document the new `FS_BASE_DIRECTORY` feature.
  - `docs/tree.md` updated to reflect the inclusion of `CHANGELOG.md` (though this was part of the diff, it's a documentation update).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2025-05-23

### Added

- **HTTP Transport Support**: Introduced an HTTP transport layer (`src/mcp-server/transports/httpTransport.ts`) alongside the existing STDIO transport. This allows the server to be accessed over the network.
  - Includes JWT-based authentication (`src/mcp-server/transports/authentication/authMiddleware.ts`) for secure HTTP communication.
  - Supports RESTful endpoints and Server-Sent Events (SSE) for streaming.
- **Enhanced Configuration System**: Major overhaul of `src/config/index.ts` using Zod for robust validation of environment variables.
  - Added new configuration options for HTTP transport (port, host, allowed origins, auth secret key).
  - Added new configuration options for LLM integrations (OpenRouter, Gemini API keys, default model parameters).
  - Added new configuration options for OAuth Proxy integration.
- **New Dependencies**: Added `express`, `jsonwebtoken`, `chrono-node`, `openai`, `partial-json`, `tiktoken` to support new features.
- **Untracked Files Added**: `mcp.json` and `smithery.yaml` are now part of the project.

### Changed

- **Utils Refactoring**: Major refactoring of the `src/utils/` directory. Utilities are now organized into subdirectories:
  - `src/utils/internal/` (errorHandler, logger, requestContext)
  - `src/utils/security/` (idGenerator, rateLimiter, sanitization)
  - `src/utils/metrics/` (tokenCounter)
  - `src/utils/parsing/` (dateParser, jsonParser)
- **Project Version**: Bumped version in `package.json` and `package-lock.json` to `1.0.1`.
- **Documentation**:
  - Updated `README.md` to reflect new features, architecture changes (transports, utils structure), and new configuration options.
  - Updated `.clinerules` (developer cheatsheet) with the new project structure and utility usage.
  - Updated `docs/tree.md` to reflect the new directory structure.
- **Tool Registration**: Minor updates in tool registration files to align with refactored utility paths and error handling.
- **Server Initialization**: Modified `src/index.ts` and `src/mcp-server/server.ts` to accommodate the new transport layer and configuration system.

### Removed

- Old top-level utility files from `src/utils/` (e.g., `errorHandler.ts`, `logger.ts`) have been moved into the new categorized subdirectories.

## [1.0.0] - Initial Release Date

- Initial release of the Filesystem MCP Server.
- Core filesystem tools: `set_filesystem_default`, `read_file`, `write_file`, `update_file`, `list_files`, `delete_file`, `delete_directory`, `create_directory`, `move_path`, `copy_path`.
- STDIO transport.
- Basic logging, error handling, and sanitization utilities.
