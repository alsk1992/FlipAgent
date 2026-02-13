/**
 * Amazon PA-API 5.0 Extended Methods
 *
 * GetVariations - fetch product variations (sizes, colors)
 * GetBrowseNodes - browse category tree
 */

import { createLogger } from '../../utils/logger';
import { signRequest, type AmazonSigningConfig, MARKETPLACE_HOSTS } from './auth';
import type { PaApiItem, PaApiError } from './types';

const logger = createLogger('amazon-extended');

export interface VariationsResult {
  items: PaApiItem[];
  totalResults?: number;
}

export interface BrowseNode {
  id: string;
  displayName: string;
  contextFreeName?: string;
  isRoot?: boolean;
  children?: Array<{ id: string; displayName: string }>;
  ancestor?: { id: string; displayName: string };
}

interface GetVariationsResponse {
  VariationsResult?: {
    Items?: PaApiItem[];
    VariationCount?: number;
  };
  Errors?: PaApiError[];
}

interface GetBrowseNodesResponse {
  BrowseNodesResult?: {
    BrowseNodes?: Array<{
      Id: string;
      DisplayName: string;
      ContextFreeName?: string;
      IsRoot?: boolean;
      Children?: Array<{ Id: string; DisplayName: string }>;
      Ancestor?: { Id: string; DisplayName: string };
    }>;
  };
  Errors?: PaApiError[];
}

export interface AmazonExtendedApi {
  getVariations(asin: string, marketplace?: string): Promise<VariationsResult>;
  getBrowseNodes(browseNodeIds: string[], marketplace?: string): Promise<BrowseNode[]>;
}

export function createAmazonExtendedApi(config: AmazonSigningConfig): AmazonExtendedApi {
  function getHostAndRegion(marketplace?: string): { host: string; region: string } {
    if (marketplace && MARKETPLACE_HOSTS[marketplace]) {
      return MARKETPLACE_HOSTS[marketplace];
    }
    return { host: config.host ?? 'webservices.amazon.com', region: config.region ?? 'us-east-1' };
  }

  async function callApi<T>(operation: string, payload: Record<string, unknown>, marketplace?: string): Promise<T> {
    const { host, region } = getHostAndRegion(marketplace);
    const signingConfig = { ...config, host, region };

    const body = JSON.stringify({
      ...payload,
      PartnerTag: config.partnerTag,
      PartnerType: 'Associates',
      Marketplace: `www.amazon.${host.split('.').pop()}`,
    });

    const headers = signRequest(operation, body, signingConfig);

    const response = await fetch(`https://${host}/paapi5/${operation.toLowerCase()}`, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, operation, error: errorText }, 'Amazon PA-API error');
      throw new Error(`Amazon PA-API ${operation} failed (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  return {
    async getVariations(asin: string, marketplace?: string): Promise<VariationsResult> {
      const data = await callApi<GetVariationsResponse>('GetVariations', {
        ASIN: asin,
        Resources: [
          'Images.Primary.Large',
          'ItemInfo.Title',
          'ItemInfo.ByLineInfo',
          'ItemInfo.ExternalIds',
          'Offers.Listings.Price',
          'Offers.Listings.Availability.Message',
          'Offers.Listings.DeliveryInfo.IsFreeShippingEligible',
          'Offers.Listings.MerchantInfo',
          'VariationSummary.Price.HighestPrice',
          'VariationSummary.Price.LowestPrice',
          'VariationSummary.VariationDimension',
        ],
      }, marketplace);

      if (data.Errors?.length) {
        const errMsg = data.Errors[0].Message ?? 'Unknown error';
        logger.error({ asin, error: errMsg }, 'GetVariations error');
        throw new Error(`GetVariations: ${errMsg}`);
      }

      return {
        items: data.VariationsResult?.Items ?? [],
        totalResults: data.VariationsResult?.VariationCount,
      };
    },

    async getBrowseNodes(browseNodeIds: string[], marketplace?: string): Promise<BrowseNode[]> {
      if (browseNodeIds.length === 0) return [];

      const data = await callApi<GetBrowseNodesResponse>('GetBrowseNodes', {
        BrowseNodeIds: browseNodeIds.slice(0, 10),
        Resources: [
          'BrowseNodes.Ancestor',
          'BrowseNodes.Children',
        ],
      }, marketplace);

      if (data.Errors?.length) {
        const errMsg = data.Errors[0].Message ?? 'Unknown error';
        logger.error({ nodeIds: browseNodeIds, error: errMsg }, 'GetBrowseNodes error');
        throw new Error(`GetBrowseNodes: ${errMsg}`);
      }

      return (data.BrowseNodesResult?.BrowseNodes ?? []).map((n) => ({
        id: n.Id,
        displayName: n.DisplayName,
        contextFreeName: n.ContextFreeName,
        isRoot: n.IsRoot,
        children: n.Children?.map((c) => ({ id: c.Id, displayName: c.DisplayName })),
        ancestor: n.Ancestor ? { id: n.Ancestor.Id, displayName: n.Ancestor.DisplayName } : undefined,
      }));
    },
  };
}
