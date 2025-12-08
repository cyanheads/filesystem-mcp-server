/**
 * @fileoverview Main entry point for the Filesystem MCP (Model Context Protocol) server.
 * This file orchestrates the server's lifecycle:
 * 1. Initializes the core `McpServer` instance (from `@modelcontextprotocol/sdk`) with its identity and capabilities.
 * 2. Registers available filesystem tools, making them discoverable and usable by clients.
 * 3. Selects and starts the appropriate communication transport (currently stdio)
 *    based on configuration.
 * 4. Handles top-level error management during startup.
 *
 * MCP Specification References:
 * - Lifecycle: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/lifecycle.mdx
 * - Overview (Capabilities): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/index.mdx
 * - Transports: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/transports.mdx
 * @module src/mcp-server/server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config, environment } from '../config/index.js';
import { ErrorHandler, logger, requestContextService } from '../utils/index.js'; // Corrected import path
import { registerCopyPathTool } from './tools/copyPath/index.js';
import { registerCreateDirectoryTool } from './tools/createDirectory/index.js';
import { registerDeleteDirectoryTool } from './tools/deleteDirectory/index.js';
import { registerDeleteFileTool } from './tools/deleteFile/index.js';
import { registerListFilesTool } from './tools/listFiles/index.js';
import { registerMovePathTool } from './tools/movePath/index.js';
import { registerReadFileTool } from './tools/readFile/index.js';
import { registerSetFilesystemDefaultTool } from './tools/setFilesystemDefault/index.js';
import { registerUpdateFileTool } from './tools/updateFile/index.js';
import { registerWriteFileTool } from './tools/writeFile/index.js';
import { startHttpTransport } from "./transports/httpTransport.js";

/**
 * Creates and configures a new instance of the `McpServer`.
 *
 * This function defines the server's identity and capabilities as presented
 * to clients during MCP initialization.
 *
 * @returns A promise resolving with the configured `McpServer` instance.
 * @throws {Error} If any tool registration fails.
 * @private
 */
async function createMcpServerInstance(): Promise<McpServer> {
  const context = requestContextService.createRequestContext({
    operation: "createMcpServerInstance",
  });
  logger.info("Initializing MCP server instance", context);

  requestContextService.configure({
    appName: config.mcpServerName,
    appVersion: config.mcpServerVersion,
    environment,
  });

  logger.debug("Instantiating McpServer with capabilities", {
    ...context,
    serverInfo: {
      name: config.mcpServerName,
      version: config.mcpServerVersion,
    },
    capabilities: {
      resources: { listChanged: true }, // Assuming dynamic resources might be added later
      tools: { listChanged: true },     // Filesystem tools are dynamically registered
    },
  });

  const server = new McpServer(
    { name: config.mcpServerName, version: config.mcpServerVersion },
    {
      capabilities: {
        resources: { listChanged: true },
        tools: { listChanged: true },
      },
    },
  );

  try {
    logger.debug("Registering filesystem tools...", context);
    const registrationPromises = [
      registerReadFileTool(server),
      registerSetFilesystemDefaultTool(server),
      registerWriteFileTool(server),
      registerUpdateFileTool(server),
      registerListFilesTool(server),
      registerDeleteFileTool(server),
      registerDeleteDirectoryTool(server),
      registerCreateDirectoryTool(server),
      registerMovePathTool(server),
      registerCopyPathTool(server)
    ];

    await Promise.all(registrationPromises);
    logger.info("Filesystem tools registered successfully", context);
  } catch (err) {
    logger.error("Failed to register filesystem tools", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err; // Rethrow to be caught by the caller
  }

  return server;
}

/**
 * Selects, sets up, and starts the appropriate MCP transport layer based on configuration.
 * Currently, only 'stdio' transport is implemented for filesystem-mcp-server.
 *
 * @returns Resolves with `McpServer` for 'stdio'.
 * @throws {Error} If transport type is unsupported or setup fails.
 * @private
 */
async function startTransport(): Promise<McpServer | void> {
  const transportType = config.mcpTransportType; // Using the newly added config property
  const context = requestContextService.createRequestContext({
    operation: "startTransport",
    transport: transportType,
  });
  logger.info(`Starting transport: ${transportType}`, context);

  if (transportType === "http") {
    logger.debug("Delegating to startHttpTransport...", context);
    await startHttpTransport(createMcpServerInstance, context);
    return;
  }

  if (transportType === "stdio") {
    logger.debug(
      "Creating single McpServer instance for stdio transport...",
      context,
    );
    const server = await createMcpServerInstance();
    logger.debug("Connecting StdioServerTransport...", context);
    try {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info(`${config.mcpServerName} connected successfully via stdio`, {
        ...context,
        serverName: config.mcpServerName,
        version: config.mcpServerVersion
      });
    } catch (connectionError) {
      // Handle connection errors specifically
      ErrorHandler.handleError(connectionError, {
        operation: 'StdioServerTransport Connection',
        context: context, // Pass the existing context
        critical: true,
        rethrow: true // Rethrow to allow the main startup process to handle exit
      });
      // This line won't be reached if rethrow is true
      throw connectionError;
    }
    return server; // Return the single server instance for stdio.
  }

  logger.fatal(
    `Unsupported transport type configured: ${transportType}`,
    context,
  );
  throw new Error(
    `Unsupported transport type: ${transportType}. Must be 'stdio' or 'http'.`,
  );
}

/**
 * Main application entry point. Initializes and starts the MCP server.
 * Orchestrates server startup, transport selection, and top-level error handling.
 *
 * @returns For 'stdio', resolves with `McpServer`.
 *   Rejects on critical failure, leading to process exit.
 */
export async function initializeAndStartServer(): Promise<void | McpServer> {
  const context = requestContextService.createRequestContext({
    operation: "initializeAndStartServer",
  });
  logger.info("Filesystem MCP Server initialization sequence started.", context);
  try {
    const result = await startTransport();
    logger.info(
      "Filesystem MCP Server initialization sequence completed successfully.",
      context,
    );
    return result;
  } catch (err) {
    logger.fatal("Critical error during Filesystem MCP server initialization.", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    ErrorHandler.handleError(err, {
      operation: "initializeAndStartServer",
      context: context,
      critical: true,
    });
    logger.info(
      "Exiting process due to critical initialization error.",
      context,
    );
    process.exit(1); // Exit with a non-zero code to indicate failure.
  }
}
