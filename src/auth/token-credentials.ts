import {
  AzureCliCredential,
  DefaultAzureCredential,
  TokenCredential,
} from '@azure/identity';
import { KustoAuthenticationError } from '../common/errors.js';
import { criticalLog, debugLog } from '../common/utils.js';

/**
 * Factory function to create a TokenCredential based on the authentication method
 *
 * @param method The authentication method to use
 * @returns A TokenCredential instance
 */
export function createTokenCredential(
  method: string = 'azure-cli',
): TokenCredential {
  try {
    switch (method.toLowerCase()) {
      case 'azure-cli':
        debugLog('Using Azure CLI authentication');
        return new AzureCliCredential();

      case 'azure-identity':
        debugLog('Using Azure Identity authentication');
        return new DefaultAzureCredential();

      default:
        throw new KustoAuthenticationError(
          `Unsupported authentication method: ${method}`,
        );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    criticalLog(`Failed to create token credential: ${errorMessage}`);
    throw new KustoAuthenticationError(
      `Failed to create token credential: ${errorMessage}`,
    );
  }
}
