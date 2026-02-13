/**
 * AliExpress DS (Dropshipping) Order Management
 *
 * Handles placing dropshipping orders, checking order status,
 * and retrieving tracking information.
 */

import { createLogger } from '../../utils/logger';
import { callAliExpressApi, type AliExpressAuthConfig } from './auth';

const logger = createLogger('aliexpress-orders');

export interface DsOrderPlacement {
  productId: string;
  quantity: number;
  shippingAddress: {
    contactPerson: string;
    address: string;
    address2?: string;
    city: string;
    province: string;
    zip: string;
    country: string;
    phoneCountry?: string;
    mobileNo?: string;
  };
  logisticsServiceName?: string;
}

export interface DsOrderResult {
  success: boolean;
  orderId?: string;
  orderIds?: string[];
  error?: string;
}

export interface DsOrderStatus {
  orderId: string;
  orderStatus: string;
  logisticsStatus?: string;
  orderAmount?: { amount: string; currency: string };
  createdAt?: string;
}

export interface DsTrackingInfo {
  trackingNumber?: string;
  carrierCode?: string;
  logisticsStatus?: string;
  events?: Array<{
    eventDate: string;
    eventDescription: string;
    address?: string;
    status?: string;
  }>;
}

interface PlaceDsOrderResponse {
  result?: {
    is_success: boolean;
    order_list?: Array<{ order_id: number }>;
    error_code?: string;
    error_msg?: string;
  };
}

interface DsOrderStatusResponse {
  result?: {
    order_status: string;
    logistics_status?: string;
    order_amount?: { amount: string; currency_code: string };
    gmt_create?: string;
    order_id: number;
  };
}

interface DsTrackingResponse {
  result?: {
    result_success: boolean;
    details?: {
      details: Array<{
        event_desc: string;
        signed_name?: string;
        status: string;
        address: string;
        event_date: string;
      }>;
    };
    official_website?: string;
    tracking_number?: string;
    carrier_code?: string;
  };
}

interface TradeOrderResponse {
  result?: {
    order_status?: string;
    logistics_status?: string;
    order_amount?: { amount: string; currency_code: string };
    gmt_create?: string;
    child_order_list?: Array<{
      product_id: number;
      product_name: string;
      product_count: number;
      logistics_service_name?: string;
      order_status: string;
    }>;
  };
}

export interface AliExpressOrdersApi {
  placeDsOrder(order: DsOrderPlacement): Promise<DsOrderResult>;
  getDsOrderStatus(orderId: string): Promise<DsOrderStatus | null>;
  getDsOrderTracking(orderId: string): Promise<DsTrackingInfo | null>;
  getTradeOrderStatus(orderId: string): Promise<DsOrderStatus | null>;
}

export function createAliExpressOrdersApi(config: AliExpressAuthConfig): AliExpressOrdersApi {
  return {
    async placeDsOrder(order: DsOrderPlacement): Promise<DsOrderResult> {
      if (!config.accessToken) {
        return { success: false, error: 'Access token required for order placement' };
      }

      try {
        const addr = order.shippingAddress;
        const response = await callAliExpressApi<PlaceDsOrderResponse>(
          'aliexpress.trade.buy.placeorder',
          {
            product_id: order.productId,
            product_count: order.quantity,
            logistics_address: JSON.stringify({
              contact_person: addr.contactPerson,
              address: addr.address,
              address2: addr.address2 ?? '',
              city: addr.city,
              province: addr.province,
              zip: addr.zip,
              country: addr.country,
              phone_country: addr.phoneCountry ?? '+1',
              mobile_no: addr.mobileNo ?? '',
            }),
            logistics_service_name: order.logisticsServiceName,
          },
          config,
        );

        if (response.result?.is_success) {
          const orderIds = (response.result.order_list ?? []).map((o) => String(o.order_id));
          logger.info({ orderIds, productId: order.productId }, 'DS order placed');
          return {
            success: true,
            orderId: orderIds[0],
            orderIds,
          };
        }

        const errorMsg = response.result?.error_msg ?? 'Unknown order error';
        logger.error({ error: errorMsg, productId: order.productId }, 'DS order failed');
        return { success: false, error: errorMsg };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ error: msg }, 'DS order error');
        return { success: false, error: msg };
      }
    },

    async getDsOrderStatus(orderId: string): Promise<DsOrderStatus | null> {
      try {
        const response = await callAliExpressApi<DsOrderStatusResponse>(
          'aliexpress.ds.order.get',
          { order_id: orderId },
          config,
        );

        if (!response.result) return null;

        const r = response.result;
        return {
          orderId: String(r.order_id),
          orderStatus: r.order_status,
          logisticsStatus: r.logistics_status,
          orderAmount: r.order_amount
            ? { amount: r.order_amount.amount, currency: r.order_amount.currency_code }
            : undefined,
          createdAt: r.gmt_create,
        };
      } catch (err) {
        logger.error({ orderId, error: err instanceof Error ? err.message : String(err) }, 'Failed to get DS order status');
        return null;
      }
    },

    async getDsOrderTracking(orderId: string): Promise<DsTrackingInfo | null> {
      try {
        const response = await callAliExpressApi<DsTrackingResponse>(
          'aliexpress.logistics.ds.trackinginfo.query',
          { order_id: orderId },
          config,
        );

        if (!response.result?.result_success) return null;

        const r = response.result;
        return {
          trackingNumber: r.tracking_number,
          carrierCode: r.carrier_code,
          logisticsStatus: undefined,
          events: r.details?.details.map((d) => ({
            eventDate: d.event_date,
            eventDescription: d.event_desc,
            address: d.address,
            status: d.status,
          })),
        };
      } catch (err) {
        logger.error({ orderId, error: err instanceof Error ? err.message : String(err) }, 'Failed to get DS tracking');
        return null;
      }
    },

    async getTradeOrderStatus(orderId: string): Promise<DsOrderStatus | null> {
      try {
        const response = await callAliExpressApi<TradeOrderResponse>(
          'aliexpress.trade.ds.order.get',
          { order_id: orderId },
          config,
        );

        if (!response.result) return null;

        const r = response.result;
        return {
          orderId,
          orderStatus: r.order_status ?? 'UNKNOWN',
          logisticsStatus: r.logistics_status,
          orderAmount: r.order_amount
            ? { amount: r.order_amount.amount, currency: r.order_amount.currency_code }
            : undefined,
          createdAt: r.gmt_create,
        };
      } catch (err) {
        logger.error({ orderId, error: err instanceof Error ? err.message : String(err) }, 'Failed to get trade order status');
        return null;
      }
    },
  };
}
