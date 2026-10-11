import { DefaultAzureCredential, TokenCredential } from '@azure/identity';
import { AzCliCredential } from './az-cli-credential.js';
import { KustoAuthenticationError } from '../common/errors.js';
import { criticalLog, debugLog } from '../common/utils.js';

/**
 * Factory function to create a TokenCredential based on the authentication method
 *
 * @param method The authentication method to use
 * @param processTimeoutInMs Kill bound for credential subprocesses (`az`,
 *   `azd`, PowerShell). Without it @azure/identity spawns them with no
 *   timeout, so a hung `az` outlives the connect attempt that started it.
 * @returns A TokenCredential instance
 */
export function createTokenCredential(
  method: string = 'azure-cli',
  processTimeoutInMs?: number,
): TokenCredential {
  // child_process rejects a non-integer timeout, so pass only a sane value.
  const options =
    typeof processTimeoutInMs === 'number' &&
    Number.isInteger(processTimeoutInMs) &&
    processTimeoutInMs > 0
      ? { processTimeoutInMs }
      : {};
  try {
    switch (method.toLowerCase()) {
      case 'azure-cli':
        debugLog('Using Azure CLI authentication');
        // Our own az runner: on timeout it kills the whole process tree, which
        // the SDK's AzureCliCredential doesn't on Windows (#346).
        return new AzCliCredential({ timeoutMs: processTimeoutInMs });

      case 'azure-identity':
        debugLog('Using Azure Identity authentication');
        return new DefaultAzureCredential(options);

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
