/**
 * Amazon SP-API Authentication — Login with Amazon (LWA) OAuth
 *
 * Handles access token management for SP-API.
 * For private (1P) seller apps, only needs LWA refresh_token + client_id/secret.
 * No IAM role needed for self-authorized apps.
 */

import { createLogger } from '../../utils/logger';

const logger = createLogger('amazon-sp-auth');

export interface SpApiAuthConfig {
  /** LWA client ID */
  clientId: string;
  /** LWA client secret */
  clientSecret: string;
  /** LWA refresh token (from Seller Central app authorization) */
  refreshToken: string;
  /** SP-API endpoint (default: https://sellingpartnerapi-na.amazon.com) */
  endpoint?: string;
  /** Marketplace ID (default: ATVPDKIKX0DER for US) */
  marketplaceId?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

const tokenCache = new Map<string, CachedToken>();

export const SP_API_ENDPOINTS: Record<string, string> = {
  NA: 'https://sellingpartnerapi-na.amazon.com',
  EU: 'https://sellingpartnerapi-eu.amazon.com',
  FE: 'https://sellingpartnerapi-fe.amazon.com',
};

export const MARKETPLACE_IDS: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  UK: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  IT: 'APJ6JRA9NG5V4',
  ES: 'A1RKKUPIHCS9HS',
  JP: 'A1VC38T7YXB528',
  AU: 'A39IBJ37TRP1C6',
  IN: 'A21TJRUUN4KGV',
};

/**
 * Get a valid LWA access token, refreshing if needed.
 */
export async function getSpApiToken(config: SpApiAuthConfig): Promise<string> {
  const cacheKey = `${config.clientId}:sp`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status, error: errorText }, 'LWA token refresh failed');
    throw new Error(`LWA token refresh failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };

  const token: CachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  tokenCache.set(cacheKey, token);
  logger.info({ expiresIn: data.expires_in }, 'SP-API access token obtained');
  return token.accessToken;
}

export function clearSpApiTokenCache(): void {
  tokenCache.clear();
}
