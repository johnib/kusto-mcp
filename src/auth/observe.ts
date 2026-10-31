/**
 * GetTokenOptions key for a TokenObservation (see token-credentials.ts): the
 * caching credential counts that caller's own fetches and cache hits and the
 * token's source into it. Kept apart from token-credentials.ts, which unit
 * tests often mock wholesale.
 */
export const OBSERVE = 'kustoMcpObserve';

export interface TokenObservation {
  fetches: number;
  hits: number;
  source?:
    | 'env'
    | 'wi'
    | 'mi'
    | 'vscode'
    | 'az'
    | 'pwsh'
    | 'azd'
    | 'broker'
    | 'unknown';
}
