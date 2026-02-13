/**
 * AliExpress API - Request signing (HMAC-SHA256)
 *
 * Signs requests for the AliExpress Affiliate/Dropshipping API.
 * All API calls are signed HTTP POST to the gateway endpoint.
 */

import * as crypto from 'crypto';
import { createLogger } from '../../utils/logger';

const logger = createLogger('aliexpress-auth');

export interface AliExpressAuthConfig {
  appKey: string;
  appSecret: string;
  accessToken?: string;
}

const API_GATEWAY = 'https://api-sg.aliexpress.com/sync';

/**
 * Generate HMAC-SHA256 signature for AliExpress API request.
 *
 * Algorithm:
 * 1. Sort all params alphabetically by key
 * 2. Concatenate as key1value1key2value2...
 * 3. HMAC-SHA256 with appSecret, uppercase hex result
 */
function signParams(params: Record<string, string>, appSecret: string): string {
  const sorted = Object.keys(params).sort();
  const concatenated = sorted.map(k => `${k}${params[k]}`).join('');
  return crypto
    .createHmac('sha256', appSecret)
    .update(concatenated, 'utf8')
    .digest('hex')
    .toUpperCase();
}

/**
 * Build a signed API request URL and body for AliExpress.
 *
 * @param method - API method name (e.g. "aliexpress.affiliate.product.query")
 * @param businessParams - method-specific parameters
 * @param config - App key + secret
 * @returns { url, body } ready for fetch POST
 */
export function buildSignedRequest(
  method: string,
  businessParams: Record<string, unknown>,
  config: AliExpressAuthConfig,
): { url: string; body: string; headers: Record<string, string> } {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const systemParams: Record<string, string> = {
    app_key: config.appKey,
    method,
    sign_method: 'sha256',
    timestamp,
    v: '2.0',
    format: 'json',
  };

  if (config.accessToken) {
    systemParams.session = config.accessToken;
  }

  // Flatten business params to strings
  const allParams: Record<string, string> = { ...systemParams };
  for (const [key, value] of Object.entries(businessParams)) {
    if (value !== undefined && value !== null) {
      allParams[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }

  allParams.sign = signParams(allParams, config.appSecret);

  const body = new URLSearchParams(allParams).toString();

  return {
    url: API_GATEWAY,
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
  };
}

/**
 * Execute a signed AliExpress API call.
 */
// ─── OAuth Token Management ───

const OAUTH_GATEWAY = 'https://api-sg.aliexpress.com';

export interface AliExpressOAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
}

/**
 * Obtain an OAuth access token using an authorization code.
 * Called after user authorizes the app via AliExpress developer portal.
 */
export async function obtainAliExpressToken(
  code: string,
  config: { appKey: string; appSecret: string },
): Promise<AliExpressOAuthToken> {
  const params: Record<string, string> = {
    app_key: config.appKey,
    sign_method: 'sha256',
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    code,
  };

  params.sign = signParams(params, config.appSecret);

  const response = await fetch(`${OAUTH_GATEWAY}/auth/token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AliExpress OAuth token create failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token: string;
    expire_time: string; // millisecond timestamp
    refresh_token_valid_time: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: parseInt(data.expire_time, 10),
    refreshExpiresAt: parseInt(data.refresh_token_valid_time, 10),
  };
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAliExpressToken(
  refreshToken: string,
  config: { appKey: string; appSecret: string },
): Promise<AliExpressOAuthToken> {
  const params: Record<string, string> = {
    app_key: config.appKey,
    sign_method: 'sha256',
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    refresh_token: refreshToken,
  };

  params.sign = signParams(params, config.appSecret);

  const response = await fetch(`${OAUTH_GATEWAY}/auth/token/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AliExpress OAuth token refresh failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token: string;
    expire_time: string;
    refresh_token_valid_time: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: parseInt(data.expire_time, 10),
    refreshExpiresAt: parseInt(data.refresh_token_valid_time, 10),
  };
}

/**
 * Get a valid access token, refreshing if needed.
 * Caches tokens per appKey.
 */
const oauthTokenCache = new Map<string, AliExpressOAuthToken>();

export async function getValidAliExpressToken(
  config: { appKey: string; appSecret: string },
  storedRefreshToken?: string,
): Promise<string | null> {
  const cached = oauthTokenCache.get(config.appKey);

  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  const rtToUse = cached?.refreshToken ?? storedRefreshToken;
  if (!rtToUse) {
    logger.warn('No refresh token available for AliExpress OAuth');
    return null;
  }

  if (cached && Date.now() > cached.refreshExpiresAt) {
    logger.error('AliExpress refresh token expired, re-authorization required');
    return null;
  }

  try {
    const newToken = await refreshAliExpressToken(rtToUse, config);
    oauthTokenCache.set(config.appKey, newToken);
    return newToken.accessToken;
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Token refresh failed');
    return null;
  }
}

// ─── API Call Helper ───

export async function callAliExpressApi<T = unknown>(
  method: string,
  businessParams: Record<string, unknown>,
  config: AliExpressAuthConfig,
): Promise<T> {
  const { url, body, headers } = buildSignedRequest(method, businessParams, config);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status, method, error: errorText }, 'AliExpress API request failed');
    throw new Error(`AliExpress API failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // AliExpress wraps responses in a method-specific key
  // e.g. "aliexpress_affiliate_product_query_response"
  const responseKey = method.replace(/\./g, '_') + '_response';
  const result = (data as Record<string, unknown>)[responseKey] ?? data;

  // Check for API-level errors
  const apiResult = result as Record<string, unknown>;
  if (apiResult.error_response) {
    const err = apiResult.error_response as Record<string, unknown>;
    throw new Error(`AliExpress API error: ${err.msg ?? err.sub_msg ?? JSON.stringify(err)}`);
  }

  return result as T;
}
