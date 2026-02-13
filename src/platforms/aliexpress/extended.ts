/**
 * AliExpress Extended API Methods
 *
 * Covers hot/trending products, category lists, affiliate link generation,
 * and DS product detail queries.
 */

import { createLogger } from '../../utils/logger';
import { callAliExpressApi, type AliExpressAuthConfig } from './auth';
import type { AliExpressApiProduct } from './types';

const logger = createLogger('aliexpress-extended');

export interface HotProductsQuery {
  categoryId?: string;
  pageNo?: number;
  pageSize?: number;
  keywords?: string;
  minSalePrice?: number;
  maxSalePrice?: number;
  sort?: 'SALE_PRICE_ASC' | 'SALE_PRICE_DESC' | 'LAST_VOLUME_ASC' | 'LAST_VOLUME_DESC';
}

export interface CategoryInfo {
  categoryId: number;
  categoryName: string;
  parentCategoryId?: number;
  isLeaf?: boolean;
}

export interface AffiliateLink {
  promotionLink: string;
  sourceUrl: string;
}

export interface DsProductDetail {
  productId: string;
  title: string;
  price: string;
  currency: string;
  imageUrl?: string;
  packageLength?: number;
  packageWidth?: number;
  packageHeight?: number;
  packageWeight?: string;
  skuAttributes?: Array<{
    skuId: string;
    skuPrice: string;
    skuStock: boolean;
    skuAttr: string;
  }>;
}

interface HotProductsResponse {
  resp_result?: {
    resp_code: number;
    resp_msg: string;
    result?: {
      current_page_no: number;
      current_record_count: number;
      total_record_count: number;
      products?: { product: AliExpressApiProduct[] };
    };
  };
}

interface CategoryResponse {
  resp_result?: {
    resp_code: number;
    result?: {
      categories?: Array<{
        category_id: number;
        category_name: string;
        parent_category_id?: number;
        is_leaf_category?: boolean;
      }>;
    };
  };
}

interface LinkGenerateResponse {
  resp_result?: {
    resp_code: number;
    result?: {
      promotion_links?: Array<{
        promotion_link: string;
        source_value: string;
      }>;
    };
  };
}

interface DsProductDetailResponse {
  result?: {
    product_id: number;
    product_title: string;
    product_price: string;
    product_price_currency: string;
    product_main_image_url?: string;
    package_length?: number;
    package_width?: number;
    package_height?: number;
    package_weight?: string;
    sku_info_list?: Array<{
      sku_id: string;
      sku_price: string;
      sku_stock: boolean;
      sku_attr: string;
    }>;
  };
}

export interface AliExpressExtendedApi {
  getHotProducts(query?: HotProductsQuery): Promise<AliExpressApiProduct[]>;
  queryHotProducts(query?: HotProductsQuery): Promise<AliExpressApiProduct[]>;
  getCategories(): Promise<CategoryInfo[]>;
  generateAffiliateLinks(urls: string[]): Promise<AffiliateLink[]>;
  getDsProductDetail(productId: string): Promise<DsProductDetail | null>;
}

export function createAliExpressExtendedApi(config: AliExpressAuthConfig): AliExpressExtendedApi {
  return {
    async getHotProducts(query?: HotProductsQuery): Promise<AliExpressApiProduct[]> {
      const params: Record<string, unknown> = {
        page_no: query?.pageNo ?? 1,
        page_size: query?.pageSize ?? 20,
      };
      if (query?.categoryId) params.category_id = query.categoryId;
      if (query?.keywords) params.keywords = query.keywords;
      if (query?.minSalePrice) params.min_sale_price = query.minSalePrice;
      if (query?.maxSalePrice) params.max_sale_price = query.maxSalePrice;
      if (query?.sort) params.sort = query.sort;

      const response = await callAliExpressApi<HotProductsResponse>(
        'aliexpress.affiliate.hotproduct.download',
        params,
        config,
      );

      const products = response.resp_result?.result?.products?.product;
      if (!products) {
        logger.debug('No hot products returned');
        return [];
      }
      return products;
    },

    async queryHotProducts(query?: HotProductsQuery): Promise<AliExpressApiProduct[]> {
      const params: Record<string, unknown> = {
        page_no: query?.pageNo ?? 1,
        page_size: query?.pageSize ?? 20,
      };
      if (query?.categoryId) params.category_id = query.categoryId;
      if (query?.keywords) params.keywords = query.keywords;
      if (query?.minSalePrice) params.min_sale_price = query.minSalePrice;
      if (query?.maxSalePrice) params.max_sale_price = query.maxSalePrice;
      if (query?.sort) params.sort = query.sort;

      const response = await callAliExpressApi<HotProductsResponse>(
        'aliexpress.affiliate.hotproduct.query',
        params,
        config,
      );

      const products = response.resp_result?.result?.products?.product;
      if (!products) {
        logger.debug('No hot products from query');
        return [];
      }
      return products;
    },

    async getCategories(): Promise<CategoryInfo[]> {
      const response = await callAliExpressApi<CategoryResponse>(
        'aliexpress.affiliate.category.get',
        {},
        config,
      );

      const categories = response.resp_result?.result?.categories;
      if (!categories) return [];

      return categories.map((c) => ({
        categoryId: c.category_id,
        categoryName: c.category_name,
        parentCategoryId: c.parent_category_id,
        isLeaf: c.is_leaf_category,
      }));
    },

    async generateAffiliateLinks(urls: string[]): Promise<AffiliateLink[]> {
      if (urls.length === 0) return [];

      const response = await callAliExpressApi<LinkGenerateResponse>(
        'aliexpress.affiliate.link.generate',
        {
          source_values: urls.join(','),
          promotion_link_type: 0, // 0 = search link, 1 = hot link
        },
        config,
      );

      const links = response.resp_result?.result?.promotion_links;
      if (!links) return [];

      return links.map((l) => ({
        promotionLink: l.promotion_link,
        sourceUrl: l.source_value,
      }));
    },

    async getDsProductDetail(productId: string): Promise<DsProductDetail | null> {
      if (!config.accessToken) {
        logger.warn('Access token required for DS product detail');
        return null;
      }

      try {
        const response = await callAliExpressApi<DsProductDetailResponse>(
          'aliexpress.ds.product.get',
          { product_id: productId },
          config,
        );

        if (!response.result) return null;

        const r = response.result;
        return {
          productId: String(r.product_id),
          title: r.product_title,
          price: r.product_price,
          currency: r.product_price_currency,
          imageUrl: r.product_main_image_url,
          packageLength: r.package_length,
          packageWidth: r.package_width,
          packageHeight: r.package_height,
          packageWeight: r.package_weight,
          skuAttributes: r.sku_info_list?.map((s) => ({
            skuId: s.sku_id,
            skuPrice: s.sku_price,
            skuStock: s.sku_stock,
            skuAttr: s.sku_attr,
          })),
        };
      } catch (err) {
        logger.error({ productId, error: err instanceof Error ? err.message : String(err) }, 'DS product detail error');
        return null;
      }
    },
  };
}
