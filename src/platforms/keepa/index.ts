/**
 * Keepa API — Amazon price history, sales rank tracking, deal alerts
 *
 * Base URL: https://api.keepa.com
 * Auth: API key as query parameter (?key=xxx)
 * Rate limit: depends on plan (default ~40 tokens/min)
 *
 * Key endpoints:
 * - /product — product data + price history
 * - /search — product search by title/brand
 * - /bestsellers — category bestsellers
 * - /deals — current deals/drops
 * - /tracking — add/remove price watches
 */

import { createLogger } from '../../utils/logger';

const logger = createLogger('keepa');

const KEEPA_BASE = 'https://api.keepa.com';

export interface KeepaConfig {
  apiKey: string;
  /** Keepa domain ID (default: 1 = amazon.com) */
  domainId?: number;
}

export interface KeepaProduct {
  asin: string;
  title?: string;
  brand?: string;
  productGroup?: string;
  categoryTree?: Array<{ catId: number; name: string }>;
  rootCategory?: number;
  salesRankReference?: number;
  salesRankReferenceHistory?: number[];
  imagesCSV?: string;
  csv?: number[][]; // Price history CSV arrays by type
  stats?: {
    current?: number[];
    avg?: number[];
    avg30?: number[];
    avg90?: number[];
    avg180?: number[];
    atOfAll?: number[];
    atOfAll90?: number[];
    minPriceEver?: number[];
    maxPriceEver?: number[];
    outOfStockPercentage30?: number[];
    outOfStockPercentage90?: number[];
  };
  lastUpdate?: number;
  lastPriceChange?: number;
  trackingSince?: number;
  type?: string;
}

export interface KeepaSearchResult {
  asinList: string[];
  totalResults: number;
}

export interface KeepaDeal {
  asin: string;
  title: string;
  image: string;
  dealPrice: number;
  listPrice: number;
  percentOff: number;
  categoryId: number;
  dealCreationDate: number;
}

export interface KeepaApi {
  /** Get product data including price history */
  getProduct(params: {
    asin: string | string[];
    stats?: number;
    history?: boolean;
    offers?: number;
    rating?: boolean;
  }): Promise<KeepaProduct[]>;

  /** Search for products by title */
  search(params: {
    domain: number;
    type: 'product' | 'live';
    term: string;
    page?: number;
  }): Promise<KeepaSearchResult>;

  /** Get current deals / price drops */
  getDeals(params?: {
    page?: number;
    domainId?: number;
    priceTypes?: number[];
    deltaPercentRange?: [number, number];
    deltaRange?: [number, number];
    isRangeEnabled?: boolean;
    categoryIds?: number[];
    sortType?: number;
    isFilterEnabled?: boolean;
  }): Promise<KeepaDeal[]>;

  /** Get bestsellers for a category */
  getBestsellers(params: {
    categoryId: number;
    domainId?: number;
  }): Promise<string[]>;

  /** Add product tracking alert */
  addTracking(params: {
    asin: string;
    thresholdValue: number;
    trackingType?: number;
    domainId?: number;
  }): Promise<boolean>;

  /** Remove product tracking */
  removeTracking(asin: string): Promise<boolean>;

  /** Get token status (remaining tokens, refill time) */
  getTokenStatus(): Promise<{ tokensLeft: number; refillIn: number; refillRate: number }>;

  /** Convert Keepa price integer to dollar amount */
  keepaPriceToDollar(keepaPrice: number): number;

  /** Convert Keepa time integer to Date */
  keepaTimeToDate(keepaTime: number): Date;
}

export function createKeepaApi(config: KeepaConfig): KeepaApi {
  const domainId = config.domainId ?? 1; // amazon.com

  async function keepaFetch<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const url = new URL(path, KEEPA_BASE);
    url.searchParams.set('key', config.apiKey);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
      }
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, path, error: errorText }, 'Keepa API request failed');
      throw new Error(`Keepa API (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  // Keepa stores prices as integers (cents * 100 for some types, or keepa-cents)
  function keepaPriceToDollar(keepaPrice: number): number {
    if (keepaPrice < 0) return -1; // -1 means "out of stock" or "no data"
    return keepaPrice / 100;
  }

  // Keepa time = minutes since 2011-01-01
  const KEEPA_EPOCH = new Date('2011-01-01T00:00:00Z').getTime();
  function keepaTimeToDate(keepaTime: number): Date {
    return new Date(KEEPA_EPOCH + keepaTime * 60000);
  }

  return {
    async getProduct(params) {
      const asins = Array.isArray(params.asin) ? params.asin.join(',') : params.asin;
      const data = await keepaFetch<{ products?: KeepaProduct[] }>('/product', {
        domain: domainId,
        asin: asins,
        stats: params.stats ?? 180,
        history: params.history !== false ? 1 : 0,
        offers: params.offers ?? 0,
        rating: params.rating ? 1 : 0,
      });
      return data.products ?? [];
    },

    async search(params) {
      const data = await keepaFetch<{ asinList?: string[]; totalResults?: number }>('/search', {
        domain: params.domain ?? domainId,
        type: params.type,
        term: params.term,
        page: params.page ?? 0,
      });
      return {
        asinList: data.asinList ?? [],
        totalResults: data.totalResults ?? 0,
      };
    },

    async getDeals(params?) {
      const dealRequest: Record<string, unknown> = {
        page: params?.page ?? 0,
        domainId: params?.domainId ?? domainId,
        priceTypes: params?.priceTypes ?? [0],
        isRangeEnabled: params?.isRangeEnabled ?? true,
        isFilterEnabled: params?.isFilterEnabled ?? false,
      };
      if (params?.deltaPercentRange) {
        dealRequest.deltaPercentRange = params.deltaPercentRange;
      }
      if (params?.deltaRange) {
        dealRequest.deltaRange = params.deltaRange;
      }
      if (params?.categoryIds) {
        dealRequest.categoryIds = params.categoryIds;
      }
      if (params?.sortType !== undefined) {
        dealRequest.sortType = params.sortType;
      }

      const data = await keepaFetch<{ deals?: Array<{ asin: string; title: string; image: string; dealPrice: number; listPrice: number; percentOff: number; categories?: number[]; creationDate: number }> }>('/deal', {
        domain: params?.domainId ?? domainId,
        selection: JSON.stringify(dealRequest),
      });

      return (data.deals ?? []).map(d => ({
        asin: d.asin,
        title: d.title,
        image: d.image,
        dealPrice: keepaPriceToDollar(d.dealPrice),
        listPrice: keepaPriceToDollar(d.listPrice),
        percentOff: d.percentOff,
        categoryId: d.categories?.[0] ?? 0,
        dealCreationDate: d.creationDate,
      }));
    },

    async getBestsellers(params) {
      const data = await keepaFetch<{ bestSellersList?: { asinList?: string[] } }>('/bestsellers', {
        domain: params.domainId ?? domainId,
        category: params.categoryId,
      });
      return data.bestSellersList?.asinList ?? [];
    },

    async addTracking(params) {
      try {
        await keepaFetch('/tracking', {
          domain: params.domainId ?? domainId,
          type: 'add',
          asin: params.asin,
          thresholdValue: params.thresholdValue,
          priceType: params.trackingType ?? 0,
        });
        logger.info({ asin: params.asin, threshold: params.thresholdValue }, 'Keepa tracking added');
        return true;
      } catch (err) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to add Keepa tracking');
        return false;
      }
    },

    async removeTracking(asin) {
      try {
        await keepaFetch('/tracking', {
          domain: domainId,
          type: 'remove',
          asin,
        });
        logger.info({ asin }, 'Keepa tracking removed');
        return true;
      } catch {
        return false;
      }
    },

    async getTokenStatus() {
      const data = await keepaFetch<{ tokensLeft?: number; refillIn?: number; refillRate?: number }>('/token');
      return {
        tokensLeft: data.tokensLeft ?? 0,
        refillIn: data.refillIn ?? 0,
        refillRate: data.refillRate ?? 0,
      };
    },

    keepaPriceToDollar,
    keepaTimeToDate,
  };
}
