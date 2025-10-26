import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BaseErrorCode, McpError } from '../../../types-global/errors.js';
import { ErrorHandler } from '../../../utils/internal/errorHandler.js';
import { logger } from '../../../utils/internal/logger.js';
import { requestContextService } from '../../../utils/internal/requestContext.js';
import {
    GetFilesystemInfoInput,
    getFilesystemInfoLogic,
} from './getFilesystemInfoLogic.js';

/**
 * Registers the 'get_filesystem_info' tool with the MCP server.
 *
 * @param {McpServer} server - The McpServer instance to register the tool with.
 * @returns {Promise<void>} A promise that resolves when the tool is registered.
 * @throws {McpError} Throws an error if registration fails.
 */
export const registerGetFilesystemInfoTool = async (server: McpServer): Promise<void> => {
    const registrationContext = requestContextService.createRequestContext({ operation: 'RegisterGetFilesystemInfoTool' });
    logger.info("Attempting to register 'get_filesystem_info' tool", registrationContext);

    await ErrorHandler.tryCatch(
        async () => {
            server.tool(
                'get_filesystem_info', // Tool name
                'Gets the current working directory and filesystem scope restriction (if configured).', // Description
                {}, // No input schema needed
                async (params, extra) => {
                    const typedParams = params as GetFilesystemInfoInput;
                    const callContext = requestContextService.createRequestContext({ operation: 'GetFilesystemInfoToolExecution', parentId: registrationContext.requestId });
                    logger.info("Executing 'get_filesystem_info' tool", callContext);

                    const result = await ErrorHandler.tryCatch(
                        () => getFilesystemInfoLogic(typedParams, callContext),
                        {
                            operation: 'getFilesystemInfoLogic',
                            context: callContext,
                            input: typedParams,
                            errorCode: BaseErrorCode.INTERNAL_ERROR
                        }
                    );

                    logger.info(`Successfully executed 'get_filesystem_info'. Current working directory: ${result.currentWorkingDirectory}, Filesystem scope: ${result.filesystemScopeRestriction}`, callContext);

                    // Format the successful response
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                currentWorkingDirectory: result.currentWorkingDirectory,
                                filesystemScopeRestriction: result.filesystemScopeRestriction
                            }, null, 2)
                        }],
                    };
                }
            );
            logger.info("'get_filesystem_info' tool registered successfully", registrationContext);
        },
        {
            operation: 'registerGetFilesystemInfoTool',
            context: registrationContext,
            errorCode: BaseErrorCode.CONFIGURATION_ERROR,
            critical: true
        }
    );
};