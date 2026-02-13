/**
 * eBay Fulfillment API - Order management
 *
 * Handles retrieving orders and pushing shipping fulfillment info.
 */

import { createLogger } from '../../utils/logger';
import type { EbayCredentials } from '../../types';
import type { EbayOrdersResponse, EbayOrder, EbayShippingFulfillment } from './types';
import { getAccessToken, API_BASE } from './auth';

const logger = createLogger('ebay-orders');

export interface EbayRefundRequest {
  reasonForRefund: 'BUYER_CANCEL' | 'ITEM_NOT_RECEIVED' | 'ITEM_NOT_AS_DESCRIBED' | 'OTHER';
  comment?: string;
  orderLevelRefundAmount?: { value: string; currency: string };
}

export interface EbayOrdersApi {
  getOrders(filter?: string): Promise<EbayOrder[]>;
  getUnfulfilledOrders(): Promise<EbayOrder[]>;
  getOrder(orderId: string): Promise<EbayOrder | null>;
  createShippingFulfillment(orderId: string, fulfillment: EbayShippingFulfillment): Promise<string>;
  issueRefund(orderId: string, refund: EbayRefundRequest): Promise<{ refundId: string; refundStatus: string }>;
}

export function createEbayOrdersApi(credentials: EbayCredentials): EbayOrdersApi {
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
    async getOrders(filter?: string): Promise<EbayOrder[]> {
      const token = await getToken();

      const params = new URLSearchParams({ limit: '50' });
      if (filter) {
        params.set('filter', filter);
      }

      const response = await fetch(
        `${baseUrl}/sell/fulfillment/v1/order?${params.toString()}`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to get eBay orders');
        throw new Error(`eBay get orders failed (${response.status})`);
      }

      const data = await response.json() as EbayOrdersResponse;
      return data.orders ?? [];
    },

    async getUnfulfilledOrders(): Promise<EbayOrder[]> {
      return this.getOrders('orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}');
    },

    async getOrder(orderId: string): Promise<EbayOrder | null> {
      const token = await getToken();

      const response = await fetch(
        `${baseUrl}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok) {
        if (response.status === 404) return null;
        const errorText = await response.text();
        logger.error({ status: response.status, orderId, error: errorText }, 'Failed to get eBay order');
        return null;
      }

      return await response.json() as EbayOrder;
    },

    async createShippingFulfillment(orderId: string, fulfillment: EbayShippingFulfillment): Promise<string> {
      const token = await getToken();

      const response = await fetch(
        `${baseUrl}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fulfillment),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, orderId, error: errorText }, 'Failed to create shipping fulfillment');
        throw new Error(`eBay create shipping fulfillment failed (${response.status}): ${errorText}`);
      }

      // The fulfillmentId is returned in the Location header
      const locationHeader = response.headers.get('location') ?? '';
      const fulfillmentId = locationHeader.split('/').pop() ?? '';

      logger.info({ orderId, fulfillmentId }, 'Shipping fulfillment created');
      return fulfillmentId;
    },

    async issueRefund(orderId: string, refund: EbayRefundRequest): Promise<{ refundId: string; refundStatus: string }> {
      const token = await getToken();

      const response = await fetch(
        `${baseUrl}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/issue_refund`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(refund),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, orderId, error: errorText }, 'Failed to issue refund');
        throw new Error(`eBay issue refund failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { refundId: string; refundStatus: string };
      logger.info({ orderId, refundId: data.refundId, status: data.refundStatus }, 'Refund issued');
      return data;
    },
  };
}
