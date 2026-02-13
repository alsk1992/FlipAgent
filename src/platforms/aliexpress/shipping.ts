/**
 * AliExpress Shipping/Logistics API
 *
 * Provides shipping cost calculation and logistics queries.
 */

import { createLogger } from '../../utils/logger';
import { callAliExpressApi, type AliExpressAuthConfig } from './auth';

const logger = createLogger('aliexpress-shipping');

export interface ShippingCostQuery {
  productId: string;
  productNum?: number;
  country: string;
}

export interface ShippingMethod {
  serviceName: string;
  freightAmount: { amount: string; currency: string };
  deliveryDayMin?: number;
  deliveryDayMax?: number;
  trackingAvailable?: boolean;
}

export interface FreightResponse {
  result?: {
    freight_list?: Array<{
      service_name: string;
      freight?: { amount: string; cent: number; currency_code: string };
      estimated_delivery_time?: string;
      tracking_available?: string;
    }>;
    error_code?: number;
    error_msg?: string;
  };
}

export interface AliExpressShippingApi {
  queryShippingCost(query: ShippingCostQuery): Promise<ShippingMethod[]>;
  getCheapestShipping(productId: string, country?: string): Promise<ShippingMethod | null>;
}

export function createAliExpressShippingApi(config: AliExpressAuthConfig): AliExpressShippingApi {
  return {
    async queryShippingCost(query: ShippingCostQuery): Promise<ShippingMethod[]> {
      const response = await callAliExpressApi<FreightResponse>(
        'aliexpress.logistics.buyer.freight.calculate',
        {
          product_id: query.productId,
          product_num: query.productNum ?? 1,
          country_code: query.country,
        },
        config,
      );

      const freightList = response.result?.freight_list;
      if (!freightList || freightList.length === 0) {
        logger.warn({ productId: query.productId, country: query.country }, 'No shipping methods found');
        return [];
      }

      return freightList.map((f) => {
        const deliveryDays = f.estimated_delivery_time
          ? f.estimated_delivery_time.split('-').map(Number)
          : undefined;

        return {
          serviceName: f.service_name,
          freightAmount: {
            amount: f.freight?.amount ?? '0',
            currency: f.freight?.currency_code ?? 'USD',
          },
          deliveryDayMin: deliveryDays?.[0],
          deliveryDayMax: deliveryDays?.[1] ?? deliveryDays?.[0],
          trackingAvailable: f.tracking_available === 'true',
        };
      });
    },

    async getCheapestShipping(productId: string, country = 'US'): Promise<ShippingMethod | null> {
      const methods = await this.queryShippingCost({ productId, country });
      if (methods.length === 0) return null;

      return methods.reduce((cheapest, current) => {
        const cheapestPrice = parseFloat(cheapest.freightAmount.amount) || 0;
        const currentPrice = parseFloat(current.freightAmount.amount) || 0;
        return currentPrice < cheapestPrice ? current : cheapest;
      });
    },
  };
}
