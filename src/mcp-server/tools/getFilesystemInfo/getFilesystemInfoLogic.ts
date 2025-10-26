import { serverState } from '../../state.js';
import { RequestContext } from '../../../utils/internal/requestContext.js';

/**
 * Input schema for getFilesystemInfo - no inputs required
 */
export const GetFilesystemInfoInputSchema = {};

/**
 * TypeScript type for the input (empty object)
 */
export type GetFilesystemInfoInput = Record<string, never>;

/**
 * Output type for getFilesystemInfo
 */
export interface GetFilesystemInfoOutput {
    currentWorkingDirectory: string | null;
    filesystemScopeRestriction: string | null;
}

/**
 * Gets the current filesystem information including working directory and scope restriction.
 *
 * @param {GetFilesystemInfoInput} input - Empty input object.
 * @param {RequestContext} context - The request context for logging.
 * @returns {Promise<GetFilesystemInfoOutput>} A promise that resolves with filesystem info.
 */
export const getFilesystemInfoLogic = async (input: GetFilesystemInfoInput, context: RequestContext): Promise<GetFilesystemInfoOutput> => {
    return {
        currentWorkingDirectory: serverState.getDefaultFilesystemPath(),
        filesystemScopeRestriction: serverState.getFsBaseDirectory(),
    };
};