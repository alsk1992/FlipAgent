/**
 * Listing Creator - Generates optimized listings for selling platforms
 *
 * Wired to eBay Inventory API for real listing creation.
 * Amazon listing is flagged as manual (requires SP-API seller approval).
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger';
import type { Platform, EbayCredentials, AmazonCredentials } from '../types';
import type { ListingDraft, ListingResult } from './types';
import { createEbaySellerApi } from '../platforms/ebay/seller';
import { createAmazonSpApi } from '../platforms/amazon/sp-api';

const logger = createLogger('listing-creator');

export async function createListing(
  platform: Platform,
  draft: ListingDraft,
  credentials?: { ebay?: EbayCredentials; amazon?: AmazonCredentials },
): Promise<ListingResult> {
  logger.info({ platform, title: draft.title, price: draft.price }, 'Creating listing');

  switch (platform) {
    case 'ebay': {
      if (!credentials?.ebay) {
        return { success: false, error: 'eBay credentials not configured. Use setup_ebay_credentials first.' };
      }

      if (!credentials.ebay.refreshToken) {
        return { success: false, error: 'eBay refresh token required for listing creation. Provide refreshToken in credentials.' };
      }

      const seller = createEbaySellerApi(credentials.ebay);
      const sku = `fa-${randomUUID().slice(0, 8)}`;

      try {
        const result = await seller.createAndPublishListing({
          sku,
          title: draft.title.slice(0, 80), // eBay 80-char title limit
          description: draft.description,
          price: draft.price,
          quantity: draft.quantity,
          imageUrls: draft.imageUrls,
          categoryId: draft.category,
          condition: draft.condition === 'new' ? 'NEW'
            : draft.condition === 'refurbished' ? 'LIKE_NEW'
            : 'GOOD',
          // These policy IDs must be configured by the seller in their eBay account
          fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID ?? '',
          paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID ?? '',
          returnPolicyId: process.env.EBAY_RETURN_POLICY_ID ?? '',
        });

        return {
          success: true,
          listingId: result.listingId,
          url: `https://ebay.com/itm/${result.listingId}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ error: msg }, 'eBay listing creation failed');
        return { success: false, error: msg };
      }
    }

    case 'amazon': {
      if (credentials?.amazon?.spRefreshToken && credentials.amazon.spClientId && credentials.amazon.spClientSecret) {
        const spApi = createAmazonSpApi({
          clientId: credentials.amazon.spClientId,
          clientSecret: credentials.amazon.spClientSecret,
          refreshToken: credentials.amazon.spRefreshToken,
        });
        const sku = `fa-${randomUUID().slice(0, 8)}`;

        const conditionMap: Record<string, string> = {
          new: 'new_new',
          refurbished: 'new_new', // Amazon refurbished requires separate approval
          used: 'used_good',
        };

        try {
          const result = await spApi.putListingsItem({
            sku,
            productType: draft.category || 'PRODUCT',
            attributes: {
              item_name: [{ value: draft.title, language_tag: 'en_US' }],
              purchasable_offer: [{
                our_price: [{ schedule: [{ value_with_tax: draft.price }] }],
                currency: 'USD',
              }],
              fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: draft.quantity }],
              condition_type: [{ value: conditionMap[draft.condition] ?? 'new_new' }],
              main_product_image_locator: draft.imageUrls[0]
                ? [{ media_location: draft.imageUrls[0] }]
                : undefined,
            },
          });

          if (result.issues?.some(i => i.severity === 'ERROR')) {
            const errors = result.issues.filter(i => i.severity === 'ERROR').map(i => i.message).join('; ');
            logger.error({ sku, errors }, 'Amazon listing has errors');
            return { success: false, error: `Amazon listing issues: ${errors}` };
          }

          return {
            success: true,
            listingId: sku,
            url: `https://sellercentral.amazon.com/inventory?sku=${encodeURIComponent(sku)}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ error: msg }, 'Amazon SP-API listing creation failed');
          return { success: false, error: msg };
        }
      }

      // No SP-API credentials available — fall back to manual instructions
      return {
        success: false,
        error: 'Amazon listing creation requires SP-API credentials (spClientId, spClientSecret, spRefreshToken). Please configure them or create the listing manually on Seller Central.',
      };
    }

    default: {
      return {
        success: false,
        error: `Listing creation not supported for ${platform}. Only eBay and Amazon are supported for automated listing.`,
      };
    }
  }
}

export async function optimizeListing(
  title: string,
  description: string,
): Promise<{ title: string; description: string }> {
  // Basic optimization: capitalize important words, add key selling points
  const optimizedTitle = title
    .split(' ')
    .map(word => word.length > 3 ? word.charAt(0).toUpperCase() + word.slice(1) : word)
    .join(' ')
    .slice(0, 80);

  const optimizedDescription = description || `High-quality product. Fast shipping. Satisfaction guaranteed.`;

  return {
    title: optimizedTitle,
    description: optimizedDescription,
  };
}
