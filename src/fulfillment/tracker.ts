/**
 * Shipment Tracker - Manages tracking numbers and delivery status
 *
 * Sources tracking from:
 * - AliExpress: logistics tracking API
 * - Manual entry: carrier + tracking number
 *
 * Pushes tracking to selling platforms (eBay Fulfillment API).
 */

import { createLogger } from '../utils/logger';
import type { EbayCredentials, AliExpressCredentials, EasyPostCredentials } from '../types';
import type { ShipmentTracking } from './types';
import { callAliExpressApi, type AliExpressAuthConfig } from '../platforms/aliexpress/auth';
import type { AliExpressTrackingResponse } from '../platforms/aliexpress/types';
import { createEbayOrdersApi } from '../platforms/ebay/orders';
import { createEasyPostApi } from '../platforms/easypost';

const logger = createLogger('tracker');

export async function getTracking(
  trackingNumber: string,
  carrier?: string,
  credentials?: { aliexpress?: AliExpressCredentials; easypostApiKey?: string },
): Promise<ShipmentTracking | null> {
  logger.info({ trackingNumber, carrier }, 'Fetching tracking info');

  // If we have AliExpress credentials, try to get tracking from their API
  if (credentials?.aliexpress?.accessToken) {
    try {
      const authConfig: AliExpressAuthConfig = {
        appKey: credentials.aliexpress.appKey,
        appSecret: credentials.aliexpress.appSecret,
        accessToken: credentials.aliexpress.accessToken,
      };

      const response = await callAliExpressApi<AliExpressTrackingResponse>(
        'aliexpress.logistics.ds.trackinginfo.query',
        { logistics_no: trackingNumber },
        authConfig,
      );

      if (response.result?.result_success && response.result.details?.details) {
        const events = response.result.details.details.map(event => ({
          date: new Date(event.event_date),
          location: event.address,
          description: event.event_desc,
        }));

        const latestEvent = events[0];
        return {
          carrier: carrier ?? 'AliExpress Logistics',
          trackingNumber,
          status: latestEvent?.description ?? 'In Transit',
          events,
        };
      }
    } catch (err) {
      logger.warn({ trackingNumber, err }, 'AliExpress tracking query failed, falling back');
    }
  }

  // Fallback: Try EasyPost universal tracking
  const epKey = credentials?.easypostApiKey;
  if (epKey && trackingNumber) {
    try {
      const ep = createEasyPostApi({ apiKey: epKey });
      const tracker = await ep.createTracker(trackingNumber, carrier);
      return {
        carrier: tracker.carrier ?? carrier ?? 'Unknown',
        trackingNumber,
        status: tracker.statusDetail ?? tracker.status ?? 'In Transit',
        estimatedDelivery: tracker.estDeliveryDate ? new Date(tracker.estDeliveryDate) : undefined,
        events: tracker.trackingDetails.map(d => ({
          date: new Date(d.datetime),
          location: d.trackingLocation
            ? `${d.trackingLocation.city ?? ''}, ${d.trackingLocation.state ?? ''} ${d.trackingLocation.zip ?? ''}`.trim()
            : '',
          description: d.message ?? d.status ?? '',
        })),
      };
    } catch (err) {
      logger.warn({ trackingNumber, err }, 'EasyPost tracking failed, using fallback');
    }
  }

  // Fallback: return basic tracking info (no external tracking API configured)
  return {
    carrier: carrier ?? 'Unknown',
    trackingNumber,
    status: 'Tracking info unavailable - configure tracking API or check carrier website',
    events: [],
  };
}

export async function updateTrackingOnPlatform(
  platform: string,
  orderId: string,
  trackingNumber: string,
  carrier: string,
  credentials?: { ebay?: EbayCredentials },
): Promise<boolean> {
  logger.info({ platform, orderId, trackingNumber, carrier }, 'Updating tracking on platform');

  if (platform === 'ebay' && credentials?.ebay?.refreshToken) {
    try {
      const ordersApi = createEbayOrdersApi(credentials.ebay);

      // Get the order to find line items
      const ebayOrder = await ordersApi.getOrder(orderId);
      if (!ebayOrder) {
        logger.error({ orderId }, 'eBay order not found for tracking update');
        return false;
      }

      const lineItems = ebayOrder.lineItems.map(li => ({
        lineItemId: li.lineItemId,
        quantity: li.quantity,
      }));

      // Map common carrier names to eBay carrier codes
      const carrierCode = mapCarrierCode(carrier);

      await ordersApi.createShippingFulfillment(orderId, {
        lineItems,
        shippedDate: new Date().toISOString(),
        shippingCarrierCode: carrierCode,
        trackingNumber,
      });

      logger.info({ orderId, trackingNumber }, 'Tracking pushed to eBay');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ orderId, error: msg }, 'Failed to push tracking to eBay');
      return false;
    }
  }

  logger.warn({ platform }, 'Tracking update not supported for this platform');
  return false;
}

function mapCarrierCode(carrier: string): string {
  const normalized = carrier.toUpperCase().replace(/[^A-Z]/g, '');
  if (normalized.includes('USPS')) return 'USPS';
  if (normalized.includes('UPS')) return 'UPS';
  if (normalized.includes('FEDEX')) return 'FEDEX';
  if (normalized.includes('DHL')) return 'DHL';
  if (normalized.includes('YANWEN')) return 'YANWEN';
  if (normalized.includes('CAINIAO')) return 'CAINIAO';
  if (normalized.includes('CHINA') || normalized.includes('EPACKET')) return 'CHINA_POST';
  return 'OTHER';
}
