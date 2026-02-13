/**
 * eBay OAuth 2.0 - Token management
 *
 * Handles client_credentials and authorization_code grant types.
 * Caches access tokens and auto-refreshes before expiry.
 */

import { createLogger } from '../../utils/logger';

const logger = createLogger('ebay-auth');

export interface EbayAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  environment?: 'sandbox' | 'production';
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const ENDPOINTS = {
  production: 'https://api.ebay.com/identity/v1/oauth2/token',
  sandbox: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
};

export const API_BASE = {
  production: 'https://api.ebay.com',
  sandbox: 'https://api.sandbox.ebay.com',
};

// Token cache: key = clientId, value = { accessToken, expiresAt }
const tokenCache = new Map<string, CachedToken>();

/**
 * Get a valid access token, refreshing if needed.
 *
 * Uses client_credentials grant for Browse API (read-only) access.
 * Uses refresh_token grant for Sell APIs (listing, fulfillment) if refreshToken provided.
 */
export async function getAccessToken(config: EbayAuthConfig): Promise<string> {
  const env = config.environment ?? 'production';
  const cacheKey = `${config.clientId}:${env}`;

  // Check cache
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  const endpoint = ENDPOINTS[env];
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const body = config.refreshToken
    ? new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: config.refreshToken,
        scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.fulfillment https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.finances https://api.ebay.com/oauth/api_scope/sell.analytics.readonly https://api.ebay.com/oauth/api_scope/sell.marketing https://api.ebay.com/oauth/api_scope/commerce.taxonomy.readonly',
      })
    : new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.ebay.com/oauth/api_scope',
      });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status, error: errorText }, 'eBay OAuth token request failed');
    throw new Error(`eBay OAuth failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };

  const token: CachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  tokenCache.set(cacheKey, token);
  logger.info({ env, expiresIn: data.expires_in }, 'eBay access token obtained');

  return token.accessToken;
}

/**
 * Clear cached tokens (useful when credentials change).
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}
