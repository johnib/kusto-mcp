import { CloudSettings } from 'azure-kusto-data';

/**
 * The token scope azure-kusto-data asks the credential for, derived the same
 * way as its CloudSettingsTokenProvider (tokenProvider.js): the cluster's
 * cloud metadata resource id, with `.kusto.` swapped for `.kustomfa.` when the
 * cloud requires MFA. Fetching exactly this scope through the caching
 * credential lets the SDK's own request hit the cache, so a connect costs one
 * token fetch instead of two. A unit test against the real SDK guards drift.
 *
 * Also performs the cloud-metadata GET (cached in the SDK's module-level
 * CloudSettings, so the SDK's own lookup later is free). Throws when the
 * cluster can't be reached.
 */
export async function kustoTokenScope(clusterUrl: string): Promise<string> {
  const cloudInfo = await CloudSettings.getCloudInfoForCluster(clusterUrl);
  let resourceUri = cloudInfo.KustoServiceResourceId;
  if (cloudInfo.LoginMfaRequired) {
    resourceUri = resourceUri.replace('.kusto.', '.kustomfa.');
  }
  return `${resourceUri}/.default`;
}
