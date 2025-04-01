import { AccessToken, GetTokenOptions, TokenCredential } from "@azure/identity";
import axios from "axios";
import { KustoAuthenticationError } from "../common/errors.js";
import { safeLog } from "../common/utils.js";

/**
 * Interface for token response from the local server
 */
interface TokenResponse {
  token: string;
  expiresOn: string;
}

/**
 * Implementation of TokenCredential that gets tokens from a local server
 * Similar to the C# AzRestTokenCredentials implementation
 */
export class AzureTokenCredentials implements TokenCredential {
  private httpClient = axios.create();
  private tokenEndpoint: string;
  
  /**
   * Create a new instance of AzureTokenCredentials
   * 
   * @param tokenEndpoint The endpoint to get tokens from (defaults to http://localhost:5000/token)
   */
  constructor(tokenEndpoint: string = "http://localhost:5000/token") {
    this.tokenEndpoint = tokenEndpoint;
    safeLog(`AzureTokenCredentials initialized with endpoint: ${tokenEndpoint}`);
  }
  
  /**
   * Get a token for the specified scope
   * 
   * @param scopes The scopes to get a token for
   * @param options Options for the token request
   * @returns A promise that resolves to an AccessToken
   */
  async getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken> {
    const scope = Array.isArray(scopes) ? scopes[0] : scopes;
    
    try {
      safeLog(`Requesting token for scope: ${scope}`);
      
      const response = await this.httpClient.post<TokenResponse>(this.tokenEndpoint, {
        value: scope
      });
      
      if (!response.data || !response.data.token) {
        throw new KustoAuthenticationError("Token response is missing token");
      }
      
      safeLog("Token acquired successfully");
      
      return {
        token: response.data.token,
        expiresOnTimestamp: new Date(response.data.expiresOn).getTime()
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      safeLog(`Token acquisition failed: ${errorMessage}`);
      throw new KustoAuthenticationError(`Failed to acquire token: ${errorMessage}`);
    }
  }
}

/**
 * Factory function to create a TokenCredential based on the authentication method
 * 
 * @param method The authentication method to use
 * @returns A TokenCredential instance
 */
export function createTokenCredential(method: string = "azure-cli"): TokenCredential {
  switch (method.toLowerCase()) {
    case "azure-cli":
    case "azure-identity":
      return new AzureTokenCredentials();
    default:
      throw new KustoAuthenticationError(`Unsupported authentication method: ${method}`);
  }
}
