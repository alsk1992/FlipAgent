/**
 * eBay Taxonomy API - Category suggestions and item aspects
 *
 * Used during listing creation to find the right category and
 * required item specifics (aspects) for eBay listings.
 */

import { createLogger } from '../../utils/logger';
import type { EbayCredentials } from '../../types';
import { getAccessToken, API_BASE } from './auth';

const logger = createLogger('ebay-taxonomy');

export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  categoryTreeNodeLevel: number;
  categoryTreeNodeAncestors?: Array<{
    categoryId: string;
    categoryName: string;
  }>;
  relevancy?: string;
}

export interface ItemAspect {
  localizedAspectName: string;
  aspectConstraint: {
    aspectRequired?: boolean;
    aspectMode?: 'FREE_TEXT' | 'SELECTION_ONLY';
    aspectDataType?: string;
    itemToAspectCardinality?: 'SINGLE' | 'MULTI';
  };
  aspectValues?: Array<{
    localizedValue: string;
    valueConstraints?: Array<{
      applicableForLocalizedAspectName?: string;
      applicableForLocalizedAspectValues?: string[];
    }>;
  }>;
}

export interface EbayTaxonomyApi {
  getCategorySuggestions(query: string, marketplaceId?: string): Promise<CategorySuggestion[]>;
  getItemAspectsForCategory(categoryId: string, categoryTreeId?: string): Promise<ItemAspect[]>;
  getDefaultCategoryTreeId(marketplaceId?: string): Promise<string>;
}

export function createEbayTaxonomyApi(credentials: EbayCredentials): EbayTaxonomyApi {
  const env = credentials.environment ?? 'production';
  const baseUrl = API_BASE[env];

  async function getToken(): Promise<string> {
    return getAccessToken({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      environment: env,
    });
  }

  return {
    async getCategorySuggestions(query: string, marketplaceId?: string): Promise<CategorySuggestion[]> {
      const token = await getToken();
      const treeId = await this.getDefaultCategoryTreeId(marketplaceId);

      const response = await fetch(
        `${baseUrl}/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(query)}`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, query, error: errorText }, 'Category suggestions failed');
        return [];
      }

      const data = await response.json() as {
        categorySuggestions?: Array<{
          category: { categoryId: string; categoryName: string; categoryTreeNodeLevel: number };
          categoryTreeNodeAncestors?: Array<{ categoryId: string; categoryName: string }>;
          relevancy?: string;
        }>;
      };

      return (data.categorySuggestions ?? []).map((s) => ({
        categoryId: s.category.categoryId,
        categoryName: s.category.categoryName,
        categoryTreeNodeLevel: s.category.categoryTreeNodeLevel,
        categoryTreeNodeAncestors: s.categoryTreeNodeAncestors,
        relevancy: s.relevancy,
      }));
    },

    async getItemAspectsForCategory(categoryId: string, categoryTreeId?: string): Promise<ItemAspect[]> {
      const token = await getToken();
      const treeId = categoryTreeId ?? await this.getDefaultCategoryTreeId();

      const response = await fetch(
        `${baseUrl}/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category?category_id=${categoryId}`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, categoryId, error: errorText }, 'Item aspects query failed');
        return [];
      }

      const data = await response.json() as { aspects?: ItemAspect[] };
      return data.aspects ?? [];
    },

    async getDefaultCategoryTreeId(marketplaceId?: string): Promise<string> {
      const token = await getToken();

      const response = await fetch(
        `${baseUrl}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${marketplaceId ?? 'EBAY_US'}`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok) {
        logger.warn('Failed to get category tree ID, using default 0');
        return '0';
      }

      const data = await response.json() as { categoryTreeId: string; categoryTreeVersion: string };
      return data.categoryTreeId;
    },
  };
}
