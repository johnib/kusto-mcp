import {
  AzureCliCredential,
  DefaultAzureCredential,
  TokenCredential,
} from '@azure/identity';
import { AzCliCredential } from './az-cli-credential.js';
import { KustoAuthenticationError } from '../common/errors.js';
import { criticalLog, debugLog } from '../common/utils.js';

/**
 * Replace the Azure CLI step of a DefaultAzureCredential with our
 * tree-killing AzCliCredential (#346). Everything else stays the SDK's own:
 * credential order, env vars (incl. AZURE_TOKEN_CREDENTIALS), the managed
 * identity probe, and the chain's fall-through / hard-failure / aggregated
 * error behavior. The SDK's AzureCliCredential gets only processTimeoutInMs
 * from us, so nothing else needs carrying over.
 *
 * DefaultAzureCredential is a ChainedTokenCredential that keeps its steps in
 * `_sources`. If a future SDK drops that field, the credential is returned
 * unchanged (still bounded by processTimeoutInMs); a unit test against the
 * installed SDK fails first.
 */
export function withTreeKillingAzCli<T extends TokenCredential>(
  chain: T,
  timeoutMs?: number,
): T {
  const holder = chain as unknown as { _sources?: unknown };
  if (!Array.isArray(holder._sources)) {
    debugLog('Azure CLI step not swapped: credential chain not recognized');
    return chain;
  }
  holder._sources = holder._sources.map(source =>
    source instanceof AzureCliCredential
      ? new AzCliCredential({ timeoutMs })
      : source,
  );
  return chain;
}

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
        // The SDK chain, with only its Azure CLI step swapped for ours (#346).
        return withTreeKillingAzCli(
          new DefaultAzureCredential(options),
          processTimeoutInMs,
        );

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
