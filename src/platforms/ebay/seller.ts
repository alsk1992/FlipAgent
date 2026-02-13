/**
 * eBay Sell API - Inventory + Offer management
 *
 * Creates and manages listings via eBay's Inventory API:
 * 1. Create inventory item (PUT /sell/inventory/v1/inventory_item/{sku})
 * 2. Create offer (POST /sell/inventory/v1/offer)
 * 3. Publish offer (POST /sell/inventory/v1/offer/{offerId}/publish)
 */

import { createLogger } from '../../utils/logger';
import type { EbayCredentials } from '../../types';
import type { EbayInventoryItem, EbayOffer, EbayPublishResponse } from './types';
import { getAccessToken, API_BASE } from './auth';

const logger = createLogger('ebay-seller');

export interface EbaySellerApi {
  createInventoryItem(item: EbayInventoryItem): Promise<void>;
  createOffer(offer: EbayOffer): Promise<string>;
  publishOffer(offerId: string): Promise<EbayPublishResponse>;
  createAndPublishListing(params: {
    sku: string;
    title: string;
    description: string;
    price: number;
    quantity: number;
    imageUrls: string[];
    categoryId: string;
    condition: EbayInventoryItem['condition'];
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
  }): Promise<{ listingId: string; offerId: string }>;
  updateOfferPrice(offerId: string, newPrice: number): Promise<void>;
  withdrawOffer(offerId: string): Promise<void>;
  deleteInventoryItem(sku: string): Promise<void>;
  getInventoryItems(params?: { limit?: number; offset?: number }): Promise<{ inventoryItems: EbayInventoryItem[]; total: number }>;
  bulkUpdatePriceQuantity(updates: Array<{ sku: string; offerId: string; price?: number; quantity?: number }>): Promise<{ responses: Array<{ statusCode: number; sku: string; offerId: string; errors?: Array<{ message: string }> }> }>;
}

export function createEbaySellerApi(credentials: EbayCredentials): EbaySellerApi {
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
    async createInventoryItem(item: EbayInventoryItem): Promise<void> {
      const token = await getToken();

      const response = await fetch(
        `${baseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(item.sku)}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US',
          },
          body: JSON.stringify({
            product: item.product,
            condition: item.condition ?? 'NEW',
            availability: item.availability,
            locale: item.locale ?? 'en_US',
          }),
        },
      );

      if (!response.ok && response.status !== 204) {
        const errorText = await response.text();
        logger.error({ status: response.status, sku: item.sku, error: errorText }, 'Failed to create inventory item');
        throw new Error(`eBay create inventory item failed (${response.status}): ${errorText}`);
      }

      logger.info({ sku: item.sku }, 'Inventory item created/updated');
    },

    async createOffer(offer: EbayOffer): Promise<string> {
      const token = await getToken();

      const response = await fetch(`${baseUrl}/sell/inventory/v1/offer`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US',
        },
        body: JSON.stringify(offer),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, sku: offer.sku, error: errorText }, 'Failed to create offer');
        throw new Error(`eBay create offer failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { offerId: string };
      logger.info({ offerId: data.offerId, sku: offer.sku }, 'Offer created');
      return data.offerId;
    },

    async publishOffer(offerId: string): Promise<EbayPublishResponse> {
      const token = await getToken();

      const response = await fetch(
        `${baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, offerId, error: errorText }, 'Failed to publish offer');
        throw new Error(`eBay publish offer failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as EbayPublishResponse;
      logger.info({ listingId: data.listingId, offerId }, 'Offer published');
      return data;
    },

    async createAndPublishListing(params): Promise<{ listingId: string; offerId: string }> {
      // Step 1: Create inventory item
      await this.createInventoryItem({
        sku: params.sku,
        product: {
          title: params.title,
          description: params.description,
          imageUrls: params.imageUrls,
        },
        condition: params.condition,
        availability: {
          shipToLocationAvailability: {
            quantity: params.quantity,
          },
        },
      });

      // Step 2: Create offer
      const offerId = await this.createOffer({
        sku: params.sku,
        marketplaceId: 'EBAY_US',
        format: 'FIXED_PRICE',
        listingDescription: params.description,
        pricingSummary: {
          price: {
            value: params.price.toFixed(2),
            currency: 'USD',
          },
        },
        listingPolicies: {
          fulfillmentPolicyId: params.fulfillmentPolicyId,
          paymentPolicyId: params.paymentPolicyId,
          returnPolicyId: params.returnPolicyId,
        },
        categoryId: params.categoryId,
      });

      // Step 3: Publish offer
      const published = await this.publishOffer(offerId);

      return {
        listingId: published.listingId,
        offerId,
      };
    },

    async updateOfferPrice(offerId: string, newPrice: number): Promise<void> {
      const token = await getToken();

      // First GET the current offer to get all required fields
      const getResponse = await fetch(
        `${baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!getResponse.ok) {
        throw new Error(`eBay get offer failed (${getResponse.status})`);
      }

      const currentOffer = await getResponse.json() as EbayOffer;

      // Update price
      currentOffer.pricingSummary.price.value = newPrice.toFixed(2);

      const response = await fetch(
        `${baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(currentOffer),
        },
      );

      if (!response.ok && response.status !== 204) {
        const errorText = await response.text();
        throw new Error(`eBay update offer price failed (${response.status}): ${errorText}`);
      }

      logger.info({ offerId, newPrice }, 'Offer price updated');
    },

    async withdrawOffer(offerId: string): Promise<void> {
      const token = await getToken();

      const response = await fetch(
        `${baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok && response.status !== 204) {
        const errorText = await response.text();
        throw new Error(`eBay withdraw offer failed (${response.status}): ${errorText}`);
      }

      logger.info({ offerId }, 'Offer withdrawn');
    },

    async deleteInventoryItem(sku: string): Promise<void> {
      const token = await getToken();

      const response = await fetch(
        `${baseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok && response.status !== 204) {
        const errorText = await response.text();
        throw new Error(`eBay delete inventory item failed (${response.status}): ${errorText}`);
      }

      logger.info({ sku }, 'Inventory item deleted');
    },

    async getInventoryItems(params?): Promise<{ inventoryItems: EbayInventoryItem[]; total: number }> {
      const token = await getToken();

      const queryParams = new URLSearchParams();
      queryParams.set('limit', String(params?.limit ?? 25));
      queryParams.set('offset', String(params?.offset ?? 0));

      const response = await fetch(
        `${baseUrl}/sell/inventory/v1/inventory_item?${queryParams.toString()}`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`eBay get inventory items failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { inventoryItems?: EbayInventoryItem[]; total?: number };
      return {
        inventoryItems: data.inventoryItems ?? [],
        total: data.total ?? 0,
      };
    },

    async bulkUpdatePriceQuantity(updates): Promise<{ responses: Array<{ statusCode: number; sku: string; offerId: string; errors?: Array<{ message: string }> }> }> {
      const token = await getToken();

      const requests = updates.map((u) => ({
        sku: u.sku,
        offers: [{
          offerId: u.offerId,
          availableQuantity: u.quantity,
          price: u.price !== undefined ? { value: u.price.toFixed(2), currency: 'USD' } : undefined,
        }],
      }));

      const response = await fetch(
        `${baseUrl}/sell/inventory/v1/bulk_update_price_quantity`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ requests }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`eBay bulk update price/quantity failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { responses: Array<{ statusCode: number; sku: string; offerId: string; errors?: Array<{ message: string }> }> };
      logger.info({ updateCount: updates.length }, 'Bulk price/quantity update completed');
      return data;
    },
  };
}
