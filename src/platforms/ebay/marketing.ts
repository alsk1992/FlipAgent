/**
 * eBay Marketing API — Promoted Listings
 *
 * Endpoints:
 * - POST /sell/marketing/v1/ad_campaign — create campaign
 * - GET /sell/marketing/v1/ad_campaign — list campaigns
 * - POST /sell/marketing/v1/ad_campaign/{campaign_id}/ad — add listing to campaign
 * - GET /sell/marketing/v1/ad_campaign/{campaign_id}/ad — list ads in campaign
 * - DELETE /sell/marketing/v1/ad_campaign/{campaign_id}/ad/{ad_id} — remove ad
 * - POST /sell/marketing/v1/ad_campaign/{campaign_id}/ad/bulk_create_ads_by_listing_id — bulk add
 * - GET /sell/marketing/v1/ad_report_task — get ad performance reports
 */

import { createLogger } from '../../utils/logger';
import type { EbayCredentials } from '../../types';
import { getAccessToken, API_BASE } from './auth';

const logger = createLogger('ebay-marketing');

export interface EbayCampaign {
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  fundingStrategy: { fundingModel: string; bidPercentage?: string };
  startDate?: string;
  endDate?: string;
  marketplaceId: string;
}

export interface EbayAd {
  adId: string;
  campaignId: string;
  listingId: string;
  status: string;
  bidPercentage?: string;
}

export interface EbayMarketingApi {
  createCampaign(params: {
    campaignName: string;
    fundingModel?: 'COST_PER_SALE' | 'COST_PER_CLICK';
    bidPercentage?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<string>;

  getCampaigns(params?: {
    campaignStatus?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ campaigns: EbayCampaign[]; total: number }>;

  addAdToCampaign(campaignId: string, listingId: string, bidPercentage?: string): Promise<string>;

  getAdsInCampaign(campaignId: string, params?: {
    limit?: number;
    offset?: number;
  }): Promise<{ ads: EbayAd[]; total: number }>;

  removeAd(campaignId: string, adId: string): Promise<void>;

  bulkCreateAds(campaignId: string, listingIds: string[], bidPercentage?: string): Promise<{
    responses: Array<{ statusCode: number; listingId: string; adId?: string; errors?: Array<{ message: string }> }>;
  }>;

  pauseCampaign(campaignId: string): Promise<void>;
  resumeCampaign(campaignId: string): Promise<void>;
}

export function createEbayMarketingApi(credentials: EbayCredentials): EbayMarketingApi {
  const env = credentials.environment ?? 'production';
  const baseUrl = API_BASE[env];

  async function getToken(): Promise<string> {
    return getAccessToken({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken: credentials.refreshToken,
      environment: env,
    });
  }

  return {
    async createCampaign(params) {
      const token = await getToken();
      const response = await fetch(`${baseUrl}/sell/marketing/v1/ad_campaign`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          campaignName: params.campaignName,
          marketplaceId: 'EBAY_US',
          fundingStrategy: {
            fundingModel: params.fundingModel ?? 'COST_PER_SALE',
            bidPercentage: params.bidPercentage ?? '5.0',
          },
          startDate: params.startDate,
          endDate: params.endDate,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to create campaign');
        throw new Error(`eBay create campaign failed (${response.status}): ${errorText}`);
      }

      const location = response.headers.get('location') ?? '';
      const campaignId = location.split('/').pop() ?? '';
      logger.info({ campaignId, name: params.campaignName }, 'Campaign created');
      return campaignId;
    },

    async getCampaigns(params?) {
      const token = await getToken();
      const qp = new URLSearchParams();
      if (params?.campaignStatus) qp.set('campaign_status', params.campaignStatus);
      qp.set('limit', String(params?.limit ?? 50));
      qp.set('offset', String(params?.offset ?? 0));

      const response = await fetch(
        `${baseUrl}/sell/marketing/v1/ad_campaign?${qp.toString()}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to get campaigns');
        throw new Error(`eBay get campaigns failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { campaigns?: EbayCampaign[]; total?: number };
      return { campaigns: data.campaigns ?? [], total: data.total ?? 0 };
    },

    async addAdToCampaign(campaignId, listingId, bidPercentage?) {
      const token = await getToken();
      const response = await fetch(
        `${baseUrl}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            listingId,
            bidPercentage: bidPercentage ?? '5.0',
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to add ad');
        throw new Error(`eBay add ad failed (${response.status}): ${errorText}`);
      }

      const location = response.headers.get('location') ?? '';
      return location.split('/').pop() ?? '';
    },

    async getAdsInCampaign(campaignId, params?) {
      const token = await getToken();
      const qp = new URLSearchParams();
      qp.set('limit', String(params?.limit ?? 100));
      qp.set('offset', String(params?.offset ?? 0));

      const response = await fetch(
        `${baseUrl}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad?${qp.toString()}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to get ads');
        throw new Error(`eBay get ads failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { ads?: EbayAd[]; total?: number };
      return { ads: data.ads ?? [], total: data.total ?? 0 };
    },

    async removeAd(campaignId, adId) {
      const token = await getToken();
      const response = await fetch(
        `${baseUrl}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad/${encodeURIComponent(adId)}`,
        {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok && response.status !== 204) {
        const errorText = await response.text();
        throw new Error(`eBay remove ad failed (${response.status}): ${errorText}`);
      }

      logger.info({ campaignId, adId }, 'Ad removed from campaign');
    },

    async bulkCreateAds(campaignId, listingIds, bidPercentage?) {
      const token = await getToken();
      const response = await fetch(
        `${baseUrl}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad/bulk_create_ads_by_listing_id`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requests: listingIds.map(id => ({
              listingId: id,
              bidPercentage: bidPercentage ?? '5.0',
            })),
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`eBay bulk create ads failed (${response.status}): ${errorText}`);
      }

      return await response.json() as {
        responses: Array<{ statusCode: number; listingId: string; adId?: string; errors?: Array<{ message: string }> }>;
      };
    },

    async pauseCampaign(campaignId) {
      const token = await getToken();
      const response = await fetch(
        `${baseUrl}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/pause`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok && response.status !== 204) {
        const errorText = await response.text();
        throw new Error(`eBay pause campaign failed (${response.status}): ${errorText}`);
      }

      logger.info({ campaignId }, 'Campaign paused');
    },

    async resumeCampaign(campaignId) {
      const token = await getToken();
      const response = await fetch(
        `${baseUrl}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/resume`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok && response.status !== 204) {
        const errorText = await response.text();
        throw new Error(`eBay resume campaign failed (${response.status}): ${errorText}`);
      }

      logger.info({ campaignId }, 'Campaign resumed');
    },
  };
}
