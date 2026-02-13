/**
 * Walmart Extended API Methods
 *
 * UPC lookup, bulk item lookup, trending products, paginated items,
 * and taxonomy/category browsing.
 */

import { createLogger } from '../../utils/logger';
import type { WalmartCredentials } from '../../types';
import type { WalmartApiItem } from './types';

const logger = createLogger('walmart-extended');

const API_BASE = 'https://developer.api.walmart.com';

export interface WalmartTaxonomyCategory {
  id: string;
  name: string;
  path: string;
  children?: WalmartTaxonomyCategory[];
}

export interface WalmartExtendedApi {
  lookupByUpc(upc: string): Promise<WalmartApiItem | null>;
  bulkLookup(itemIds: string[]): Promise<WalmartApiItem[]>;
  getTrending(publisherId?: string): Promise<WalmartApiItem[]>;
  getPaginatedItems(params?: { category?: string; brand?: string; start?: number; count?: number }): Promise<{
    items: WalmartApiItem[];
    totalResults: number;
    nextPage?: number;
  }>;
  getTaxonomy(): Promise<WalmartTaxonomyCategory[]>;
}

function getHeaders(credentials: WalmartCredentials): Record<string, string> {
  return {
    'apiKey': credentials.clientId,
    'Accept': 'application/json',
  };
}

export function createWalmartExtendedApi(credentials: WalmartCredentials): WalmartExtendedApi {
  const headers = getHeaders(credentials);

  async function fetchWalmart<T>(path: string): Promise<T> {
    const url = `${API_BASE}${path}`;

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, path, error: errorText }, 'Walmart API request failed');
      throw new Error(`Walmart API (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  return {
    async lookupByUpc(upc: string): Promise<WalmartApiItem | null> {
      try {
        const data = await fetchWalmart<{ items?: WalmartApiItem[] }>(
          `/api-proxy/service/affil/product/v2/items?upc=${encodeURIComponent(upc)}`,
        );
        return data.items?.[0] ?? null;
      } catch (err) {
        logger.error({ upc, error: err instanceof Error ? err.message : String(err) }, 'UPC lookup failed');
        return null;
      }
    },

    async bulkLookup(itemIds: string[]): Promise<WalmartApiItem[]> {
      if (itemIds.length === 0) return [];

      // Walmart allows up to 20 items per bulk lookup
      const batch = itemIds.slice(0, 20).join(',');
      try {
        const data = await fetchWalmart<{ items?: WalmartApiItem[] }>(
          `/api-proxy/service/affil/product/v2/items/${batch}`,
        );
        return data.items ?? [];
      } catch (err) {
        logger.error({ count: itemIds.length, error: err instanceof Error ? err.message : String(err) }, 'Bulk lookup failed');
        return [];
      }
    },

    async getTrending(publisherId?: string): Promise<WalmartApiItem[]> {
      const params = new URLSearchParams();
      if (publisherId) params.set('publisherId', publisherId);

      try {
        const data = await fetchWalmart<{ items?: WalmartApiItem[] }>(
          `/api-proxy/service/affil/product/v2/trends${params.toString() ? '?' + params.toString() : ''}`,
        );
        return data.items ?? [];
      } catch (err) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Trending fetch failed');
        return [];
      }
    },

    async getPaginatedItems(params?): Promise<{ items: WalmartApiItem[]; totalResults: number; nextPage?: number }> {
      const queryParams = new URLSearchParams();
      if (params?.category) queryParams.set('category', params.category);
      if (params?.brand) queryParams.set('brand', params.brand);
      queryParams.set('start', String(params?.start ?? 1));
      queryParams.set('count', String(Math.min(params?.count ?? 25, 25)));

      try {
        const data = await fetchWalmart<{
          items?: WalmartApiItem[];
          totalResults?: number;
          start?: number;
          numItems?: number;
        }>(
          `/api-proxy/service/affil/product/v2/paginated/items?${queryParams.toString()}`,
        );

        const items = data.items ?? [];
        const total = data.totalResults ?? items.length;
        const start = data.start ?? 1;
        const count = data.numItems ?? items.length;

        return {
          items,
          totalResults: total,
          nextPage: start + count <= total ? start + count : undefined,
        };
      } catch (err) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Paginated items failed');
        return { items: [], totalResults: 0 };
      }
    },

    async getTaxonomy(): Promise<WalmartTaxonomyCategory[]> {
      try {
        const data = await fetchWalmart<{
          categories?: Array<{
            id: string;
            name: string;
            path: string;
            children?: WalmartTaxonomyCategory[];
          }>;
        }>(
          `/api-proxy/service/affil/product/v2/taxonomy`,
        );
        return data.categories ?? [];
      } catch (err) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Taxonomy fetch failed');
        return [];
      }
    },
  };
}
