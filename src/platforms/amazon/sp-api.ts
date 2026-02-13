/**
 * Amazon SP-API — Selling Partner API
 *
 * Real seller operations: catalog search, pricing, fees, listings, orders, inventory.
 * Uses LWA OAuth tokens (no AWS Sig V4 needed for self-authorized private apps).
 */

import { createLogger } from '../../utils/logger';
import type { SpApiAuthConfig } from './sp-auth';
import { getSpApiToken, SP_API_ENDPOINTS, MARKETPLACE_IDS } from './sp-auth';

const logger = createLogger('amazon-sp-api');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpApiCatalogItem {
  asin: string;
  title?: string;
  brand?: string;
  color?: string;
  size?: string;
  images?: Array<{ variant: string; link: string }>;
  productTypes?: Array<{ productType: string }>;
  salesRankings?: Array<{ productCategoryId: string; rank: number }>;
  itemClassification?: string;
}

export interface SpApiPricingResult {
  asin: string;
  status: string;
  buyBoxPrice?: { listingPrice: { amount: number; currency: string }; shipping: { amount: number; currency: string }; landedPrice: { amount: number; currency: string } };
  numberOfOffers?: Array<{ condition: string; fulfillmentChannel: string; offerCount: number }>;
  competitivePrices?: Array<{ competitivePriceId: string; price: { listingPrice: { amount: number }; shipping: { amount: number } }; condition: string }>;
}

export interface SpApiFeeEstimate {
  asin: string;
  totalFeesEstimate: { amount: number; currency: string };
  feeDetailList: Array<{
    feeType: string;
    feeAmount: { amount: number; currency: string };
    finalFee: { amount: number; currency: string };
  }>;
}

export interface SpApiOrder {
  amazonOrderId: string;
  purchaseDate: string;
  orderStatus: string;
  orderTotal?: { amount: string; currencyCode: string };
  numberOfItemsShipped: number;
  numberOfItemsUnshipped: number;
  fulfillmentChannel: string;
  shippingAddress?: {
    name?: string;
    addressLine1?: string;
    city?: string;
    stateOrRegion?: string;
    postalCode?: string;
    countryCode?: string;
  };
}

export interface SpApiInventorySummary {
  asin: string;
  fnSku: string;
  sellerSku: string;
  condition: string;
  totalQuantity: number;
  inventoryDetails?: {
    fulfillableQuantity?: number;
    inboundWorkingQuantity?: number;
    inboundShippedQuantity?: number;
    inboundReceivingQuantity?: number;
  };
}

export interface SpApiListingItem {
  sku: string;
  asin?: string;
  productType: string;
  attributes: Record<string, unknown>;
  issues?: Array<{ code: string; message: string; severity: string }>;
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

export interface AmazonSpApi {
  // Catalog
  searchCatalog(params: {
    keywords?: string[];
    identifiers?: string[];
    identifiersType?: 'ASIN' | 'EAN' | 'GTIN' | 'ISBN' | 'JAN' | 'MINSAN' | 'SKU' | 'UPC';
    pageSize?: number;
    pageToken?: string;
  }): Promise<{ items: SpApiCatalogItem[]; nextPageToken?: string }>;

  getCatalogItem(asin: string): Promise<SpApiCatalogItem | null>;

  // Pricing
  getCompetitivePricing(asins: string[]): Promise<SpApiPricingResult[]>;
  getItemOffers(asin: string, condition?: string): Promise<SpApiPricingResult | null>;

  // Fees
  getMyFeesEstimate(params: Array<{
    asin: string;
    price: number;
    shipping?: number;
    isAmazonFulfilled?: boolean;
  }>): Promise<SpApiFeeEstimate[]>;

  // Listings
  putListingsItem(params: {
    sku: string;
    productType: string;
    attributes: Record<string, unknown>;
    requirements?: 'LISTING' | 'LISTING_PRODUCT_ONLY' | 'LISTING_OFFER_ONLY';
  }): Promise<{ status: string; submissionId: string; issues?: Array<{ code: string; message: string; severity: string }> }>;

  patchListingsItem(params: {
    sku: string;
    productType: string;
    patches: Array<{ op: 'add' | 'replace' | 'delete'; path: string; value?: unknown }>;
  }): Promise<{ status: string; submissionId: string; issues?: Array<{ code: string; message: string; severity: string }> }>;

  deleteListingsItem(sku: string): Promise<{ status: string }>;

  // Orders
  getOrders(params?: {
    createdAfter?: string;
    orderStatuses?: string[];
    maxResults?: number;
    nextToken?: string;
  }): Promise<{ orders: SpApiOrder[]; nextToken?: string }>;

  getOrder(orderId: string): Promise<SpApiOrder | null>;

  getOrderItems(orderId: string): Promise<Array<{
    asin: string;
    sellerSku?: string;
    orderItemId: string;
    title?: string;
    quantityOrdered: number;
    quantityShipped: number;
    itemPrice?: { amount: string; currencyCode: string };
  }>>;

  // FBA Inventory
  getInventorySummaries(params?: {
    granularityType?: 'Marketplace';
    sellerSkus?: string[];
    nextToken?: string;
  }): Promise<{ summaries: SpApiInventorySummary[]; nextToken?: string }>;
}

export function createAmazonSpApi(config: SpApiAuthConfig): AmazonSpApi {
  const endpoint = config.endpoint ?? SP_API_ENDPOINTS.NA;
  const marketplaceId = config.marketplaceId ?? MARKETPLACE_IDS.US;

  async function spFetch<T>(path: string, options?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
  }): Promise<T> {
    const token = await getSpApiToken(config);
    const url = new URL(path, endpoint);
    if (options?.params) {
      for (const [k, v] of Object.entries(options.params)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = {
      method: options?.method ?? 'GET',
      headers,
    };

    if (options?.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, path, error: errorText }, 'SP-API request failed');
      throw new Error(`SP-API (${response.status}): ${errorText}`);
    }

    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }

  return {
    // -- Catalog Items API --
    async searchCatalog(params) {
      const queryParams: Record<string, string> = {
        marketplaceIds: marketplaceId,
        includedData: 'summaries,images,salesRanks,productTypes',
        pageSize: String(params.pageSize ?? 20),
      };
      if (params.keywords?.length) {
        queryParams.keywords = params.keywords.join(',');
      }
      if (params.identifiers?.length) {
        queryParams.identifiers = params.identifiers.join(',');
        queryParams.identifiersType = params.identifiersType ?? 'ASIN';
      }
      if (params.pageToken) {
        queryParams.pageToken = params.pageToken;
      }

      const data = await spFetch<{
        items?: Array<{
          asin: string;
          summaries?: Array<{ marketplaceId: string; itemName?: string; brandName?: string; color?: string; size?: string; itemClassification?: string }>;
          images?: Array<{ images?: Array<{ variant: string; link: string }> }>;
          salesRanks?: Array<{ classificationRanks?: Array<{ classificationId: string; rank: number }> }>;
          productTypes?: Array<{ productType: string }>;
        }>;
        pagination?: { nextToken?: string };
      }>('/catalog/2022-04-01/items', { params: queryParams });

      const items: SpApiCatalogItem[] = (data.items ?? []).map(item => {
        const summary = item.summaries?.[0];
        const imageSet = item.images?.[0];
        const ranks = item.salesRanks?.[0]?.classificationRanks;
        return {
          asin: item.asin,
          title: summary?.itemName,
          brand: summary?.brandName,
          color: summary?.color,
          size: summary?.size,
          itemClassification: summary?.itemClassification,
          images: imageSet?.images,
          productTypes: item.productTypes,
          salesRankings: ranks?.map(r => ({ productCategoryId: r.classificationId, rank: r.rank })),
        };
      });

      return { items, nextPageToken: data.pagination?.nextToken };
    },

    async getCatalogItem(asin) {
      try {
        const data = await spFetch<{
          asin: string;
          summaries?: Array<{ itemName?: string; brandName?: string; color?: string; size?: string; itemClassification?: string }>;
          images?: Array<{ images?: Array<{ variant: string; link: string }> }>;
          productTypes?: Array<{ productType: string }>;
        }>(`/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, {
          params: {
            marketplaceIds: marketplaceId,
            includedData: 'summaries,images,productTypes',
          },
        });

        const summary = data.summaries?.[0];
        return {
          asin: data.asin,
          title: summary?.itemName,
          brand: summary?.brandName,
          color: summary?.color,
          size: summary?.size,
          itemClassification: summary?.itemClassification,
          images: data.images?.[0]?.images,
          productTypes: data.productTypes,
        };
      } catch {
        return null;
      }
    },

    // -- Product Pricing API --
    async getCompetitivePricing(asins) {
      const results: SpApiPricingResult[] = [];
      // Batch by 20 (API limit)
      for (let i = 0; i < asins.length; i += 20) {
        const batch = asins.slice(i, i + 20);
        const data = await spFetch<{
          payload?: Array<{
            ASIN: string;
            status: string;
            Product?: {
              CompetitivePricing?: {
                CompetitivePrices?: Array<{
                  CompetitivePriceId: string;
                  Price: { ListingPrice: { Amount: number }; Shipping: { Amount: number } };
                  condition: string;
                }>;
                NumberOfOfferListings?: Array<{ Count: number; condition: string; fulfillmentChannel: string }>;
              };
            };
          }>;
        }>('/products/pricing/v0/competitivePrice', {
          params: {
            MarketplaceId: marketplaceId,
            Asins: batch.join(','),
            ItemType: 'Asin',
          },
        });

        for (const item of data.payload ?? []) {
          const cp = item.Product?.CompetitivePricing;
          results.push({
            asin: item.ASIN,
            status: item.status,
            competitivePrices: cp?.CompetitivePrices?.map(p => ({
              competitivePriceId: p.CompetitivePriceId,
              price: { listingPrice: { amount: p.Price.ListingPrice.Amount }, shipping: { amount: p.Price.Shipping.Amount } },
              condition: p.condition,
            })),
            numberOfOffers: cp?.NumberOfOfferListings?.map(o => ({
              condition: o.condition,
              fulfillmentChannel: o.fulfillmentChannel,
              offerCount: o.Count,
            })),
          });
        }
      }
      return results;
    },

    async getItemOffers(asin, condition) {
      try {
        const data = await spFetch<{
          payload?: {
            ASIN: string;
            status: string;
            Summary?: {
              LowestPrices?: Array<{ condition: string; fulfillmentChannel: string; LandedPrice: { Amount: number; CurrencyCode: string }; ListingPrice: { Amount: number }; Shipping: { Amount: number } }>;
              BuyBoxPrices?: Array<{ condition: string; LandedPrice: { Amount: number; CurrencyCode: string }; ListingPrice: { Amount: number }; Shipping: { Amount: number } }>;
              NumberOfOffers?: Array<{ condition: string; fulfillmentChannel: string; OfferCount: number }>;
            };
          };
        }>(`/products/pricing/v0/items/${encodeURIComponent(asin)}/offers`, {
          params: {
            MarketplaceId: marketplaceId,
            ItemCondition: condition ?? 'New',
          },
        });

        const payload = data.payload;
        if (!payload) return null;

        const buyBox = payload.Summary?.BuyBoxPrices?.[0];
        return {
          asin: payload.ASIN,
          status: payload.status,
          buyBoxPrice: buyBox ? {
            listingPrice: { amount: buyBox.ListingPrice.Amount, currency: buyBox.LandedPrice.CurrencyCode },
            shipping: { amount: buyBox.Shipping.Amount, currency: buyBox.LandedPrice.CurrencyCode },
            landedPrice: { amount: buyBox.LandedPrice.Amount, currency: buyBox.LandedPrice.CurrencyCode },
          } : undefined,
          numberOfOffers: payload.Summary?.NumberOfOffers?.map(o => ({
            condition: o.condition,
            fulfillmentChannel: o.fulfillmentChannel,
            offerCount: o.OfferCount,
          })),
        };
      } catch {
        return null;
      }
    },

    // -- Product Fees API --
    async getMyFeesEstimate(params) {
      const results: SpApiFeeEstimate[] = [];

      for (const p of params) {
        try {
          const data = await spFetch<{
            payload?: {
              FeesEstimateResult?: {
                Status: string;
                FeesEstimate?: {
                  TotalFeesEstimate: { Amount: number; CurrencyCode: string };
                  FeeDetailList: Array<{
                    FeeType: string;
                    FeeAmount: { Amount: number; CurrencyCode: string };
                    FinalFee: { Amount: number; CurrencyCode: string };
                  }>;
                };
              };
            };
          }>(`/products/fees/v0/items/${encodeURIComponent(p.asin)}/feesEstimate`, {
            method: 'POST',
            body: {
              FeesEstimateRequest: {
                MarketplaceId: marketplaceId,
                IsAmazonFulfilled: p.isAmazonFulfilled ?? false,
                PriceToEstimateFees: {
                  ListingPrice: { Amount: p.price, CurrencyCode: 'USD' },
                  Shipping: { Amount: p.shipping ?? 0, CurrencyCode: 'USD' },
                },
                Identifier: p.asin,
              },
            },
          });

          const est = data.payload?.FeesEstimateResult?.FeesEstimate;
          if (est) {
            results.push({
              asin: p.asin,
              totalFeesEstimate: { amount: est.TotalFeesEstimate.Amount, currency: est.TotalFeesEstimate.CurrencyCode },
              feeDetailList: est.FeeDetailList.map(f => ({
                feeType: f.FeeType,
                feeAmount: { amount: f.FeeAmount.Amount, currency: f.FeeAmount.CurrencyCode },
                finalFee: { amount: f.FinalFee.Amount, currency: f.FinalFee.CurrencyCode },
              })),
            });
          }
        } catch (err) {
          logger.warn({ asin: p.asin, error: err instanceof Error ? err.message : String(err) }, 'Fee estimate failed');
        }
      }
      return results;
    },

    // -- Listings Items API --
    async putListingsItem(params) {
      const data = await spFetch<{
        status: string;
        submissionId: string;
        issues?: Array<{ code: string; message: string; severity: string }>;
      }>(`/listings/2021-08-01/items/${encodeURIComponent('me')}/${encodeURIComponent(params.sku)}`, {
        method: 'PUT',
        params: {
          marketplaceIds: marketplaceId,
        },
        body: {
          productType: params.productType,
          requirements: params.requirements ?? 'LISTING',
          attributes: params.attributes,
        },
      });
      return data;
    },

    async patchListingsItem(params) {
      const data = await spFetch<{
        status: string;
        submissionId: string;
        issues?: Array<{ code: string; message: string; severity: string }>;
      }>(`/listings/2021-08-01/items/${encodeURIComponent('me')}/${encodeURIComponent(params.sku)}`, {
        method: 'PATCH',
        params: {
          marketplaceIds: marketplaceId,
        },
        body: {
          productType: params.productType,
          patches: params.patches,
        },
      });
      return data;
    },

    async deleteListingsItem(sku) {
      const data = await spFetch<{ status: string }>(
        `/listings/2021-08-01/items/${encodeURIComponent('me')}/${encodeURIComponent(sku)}`,
        {
          method: 'DELETE',
          params: { marketplaceIds: marketplaceId },
        },
      );
      return data;
    },

    // -- Orders API --
    async getOrders(params) {
      const queryParams: Record<string, string> = {
        MarketplaceIds: marketplaceId,
        MaxResultsPerPage: String(params?.maxResults ?? 50),
      };
      if (params?.createdAfter) {
        queryParams.CreatedAfter = params.createdAfter;
      } else {
        // Default to last 7 days
        queryParams.CreatedAfter = new Date(Date.now() - 7 * 86400000).toISOString();
      }
      if (params?.orderStatuses?.length) {
        queryParams.OrderStatuses = params.orderStatuses.join(',');
      }
      if (params?.nextToken) {
        queryParams.NextToken = params.nextToken;
      }

      const data = await spFetch<{
        payload?: {
          Orders?: Array<{
            AmazonOrderId: string;
            PurchaseDate: string;
            OrderStatus: string;
            OrderTotal?: { Amount: string; CurrencyCode: string };
            NumberOfItemsShipped: number;
            NumberOfItemsUnshipped: number;
            FulfillmentChannel: string;
            ShippingAddress?: {
              Name?: string;
              AddressLine1?: string;
              City?: string;
              StateOrRegion?: string;
              PostalCode?: string;
              CountryCode?: string;
            };
          }>;
          NextToken?: string;
        };
      }>('/orders/v0/orders', { params: queryParams });

      const orders: SpApiOrder[] = (data.payload?.Orders ?? []).map(o => ({
        amazonOrderId: o.AmazonOrderId,
        purchaseDate: o.PurchaseDate,
        orderStatus: o.OrderStatus,
        orderTotal: o.OrderTotal ? { amount: o.OrderTotal.Amount, currencyCode: o.OrderTotal.CurrencyCode } : undefined,
        numberOfItemsShipped: o.NumberOfItemsShipped,
        numberOfItemsUnshipped: o.NumberOfItemsUnshipped,
        fulfillmentChannel: o.FulfillmentChannel,
        shippingAddress: o.ShippingAddress ? {
          name: o.ShippingAddress.Name,
          addressLine1: o.ShippingAddress.AddressLine1,
          city: o.ShippingAddress.City,
          stateOrRegion: o.ShippingAddress.StateOrRegion,
          postalCode: o.ShippingAddress.PostalCode,
          countryCode: o.ShippingAddress.CountryCode,
        } : undefined,
      }));

      return { orders, nextToken: data.payload?.NextToken };
    },

    async getOrder(orderId) {
      try {
        const data = await spFetch<{
          payload?: {
            AmazonOrderId: string;
            PurchaseDate: string;
            OrderStatus: string;
            OrderTotal?: { Amount: string; CurrencyCode: string };
            NumberOfItemsShipped: number;
            NumberOfItemsUnshipped: number;
            FulfillmentChannel: string;
            ShippingAddress?: {
              Name?: string;
              AddressLine1?: string;
              City?: string;
              StateOrRegion?: string;
              PostalCode?: string;
              CountryCode?: string;
            };
          };
        }>(`/orders/v0/orders/${encodeURIComponent(orderId)}`);

        const o = data.payload;
        if (!o) return null;
        return {
          amazonOrderId: o.AmazonOrderId,
          purchaseDate: o.PurchaseDate,
          orderStatus: o.OrderStatus,
          orderTotal: o.OrderTotal ? { amount: o.OrderTotal.Amount, currencyCode: o.OrderTotal.CurrencyCode } : undefined,
          numberOfItemsShipped: o.NumberOfItemsShipped,
          numberOfItemsUnshipped: o.NumberOfItemsUnshipped,
          fulfillmentChannel: o.FulfillmentChannel,
          shippingAddress: o.ShippingAddress ? {
            name: o.ShippingAddress.Name,
            addressLine1: o.ShippingAddress.AddressLine1,
            city: o.ShippingAddress.City,
            stateOrRegion: o.ShippingAddress.StateOrRegion,
            postalCode: o.ShippingAddress.PostalCode,
            countryCode: o.ShippingAddress.CountryCode,
          } : undefined,
        };
      } catch {
        return null;
      }
    },

    async getOrderItems(orderId) {
      const data = await spFetch<{
        payload?: {
          OrderItems?: Array<{
            ASIN: string;
            SellerSKU?: string;
            OrderItemId: string;
            Title?: string;
            QuantityOrdered: number;
            QuantityShipped: number;
            ItemPrice?: { Amount: string; CurrencyCode: string };
          }>;
        };
      }>(`/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`);

      return (data.payload?.OrderItems ?? []).map(item => ({
        asin: item.ASIN,
        sellerSku: item.SellerSKU,
        orderItemId: item.OrderItemId,
        title: item.Title,
        quantityOrdered: item.QuantityOrdered,
        quantityShipped: item.QuantityShipped,
        itemPrice: item.ItemPrice ? { amount: item.ItemPrice.Amount, currencyCode: item.ItemPrice.CurrencyCode } : undefined,
      }));
    },

    // -- FBA Inventory API --
    async getInventorySummaries(params) {
      const queryParams: Record<string, string> = {
        granularityType: params?.granularityType ?? 'Marketplace',
        granularityId: marketplaceId,
        marketplaceIds: marketplaceId,
      };
      if (params?.sellerSkus?.length) {
        queryParams.sellerSkus = params.sellerSkus.join(',');
      }
      if (params?.nextToken) {
        queryParams.nextToken = params.nextToken;
      }

      const data = await spFetch<{
        payload?: {
          inventorySummaries?: Array<{
            asin: string;
            fnSku: string;
            sellerSku: string;
            condition: string;
            totalQuantity: number;
            inventoryDetails?: {
              fulfillableQuantity?: number;
              inboundWorkingQuantity?: number;
              inboundShippedQuantity?: number;
              inboundReceivingQuantity?: number;
            };
          }>;
        };
        pagination?: { nextToken?: string };
      }>('/fba/inventory/v1/summaries', { params: queryParams });

      return {
        summaries: data.payload?.inventorySummaries ?? [],
        nextToken: data.pagination?.nextToken,
      };
    },
  };
}
