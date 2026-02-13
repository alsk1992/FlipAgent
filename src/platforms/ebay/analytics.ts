/**
 * eBay Analytics API — Seller traffic and sales analytics
 *
 * Endpoints:
 * - GET /sell/analytics/v1/traffic_report — traffic stats (views, impressions, click-through)
 * - GET /sell/analytics/v1/customer_service_metric — seller performance (defect rate, late shipment)
 */

import { createLogger } from '../../utils/logger';
import type { EbayCredentials } from '../../types';
import { getAccessToken, API_BASE } from './auth';

const logger = createLogger('ebay-analytics');

export interface EbayTrafficReport {
  header: { metrics: string[]; dimensionKeys: string[] };
  records: Array<{
    dimensionValues: Array<{ value: string }>;
    metricValues: Array<{ value: string; applicable: boolean }>;
  }>;
  lastUpdatedDate?: string;
}

export interface EbaySellerMetrics {
  customerServiceMetricType: string;
  evaluationType: string;
  lookbackStartDate?: string;
  lookbackEndDate?: string;
  marketplaceId: string;
  rate?: { value: number; threshold: { value: number; comparisonOperator: string } };
  count?: number;
}

export interface EbayAnalyticsApi {
  getTrafficReport(params: {
    dimension: 'DAY' | 'LISTING';
    filter: string;
    metrics: string[];
    sort?: string;
  }): Promise<EbayTrafficReport | null>;

  getCustomerServiceMetric(params: {
    metricType: 'ITEM_NOT_AS_DESCRIBED' | 'ITEM_NOT_RECEIVED';
    evaluationType: 'CURRENT' | 'PROJECTED';
  }): Promise<EbaySellerMetrics | null>;
}

export function createEbayAnalyticsApi(credentials: EbayCredentials): EbayAnalyticsApi {
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
    async getTrafficReport(params) {
      const token = await getToken();
      const qp = new URLSearchParams();
      qp.set('dimension', params.dimension);
      qp.set('filter', params.filter);
      qp.set('metric', params.metrics.join(','));
      if (params.sort) qp.set('sort', params.sort);

      const response = await fetch(
        `${baseUrl}/sell/analytics/v1/traffic_report?${qp.toString()}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to get traffic report');
        return null;
      }

      return await response.json() as EbayTrafficReport;
    },

    async getCustomerServiceMetric(params) {
      const token = await getToken();
      const qp = new URLSearchParams();
      qp.set('customer_service_metric_type', params.metricType);
      qp.set('evaluation_type', params.evaluationType);

      const response = await fetch(
        `${baseUrl}/sell/analytics/v1/customer_service_metric?${qp.toString()}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to get seller metrics');
        return null;
      }

      const data = await response.json() as { marketplaceProfiles?: EbaySellerMetrics[] };
      return data.marketplaceProfiles?.[0] ?? null;
    },
  };
}
