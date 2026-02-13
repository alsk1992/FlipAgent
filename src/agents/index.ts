/**
 * Agent Manager
 * Handles AI agent instances and message routing for FlipAgent.
 *
 * Simplified from Clodds' ~18K lines to ~800 lines:
 * - Single agent loop with tool calling
 * - Dynamic tool loading via ToolRegistry
 * - Streaming Anthropic API
 * - Stub tool implementations (to be filled in later)
 */

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import type {
  Session,
  IncomingMessage,
  OutgoingMessage,
  Config,
  Platform,
  ConversationMessage,
  AmazonCredentials,
  EbayCredentials,
  WalmartCredentials,
  AliExpressCredentials,
  KeepaCredentials,
  EasyPostCredentials,
} from '../types';
import { createLogger } from '../utils/logger';
import {
  ToolRegistry,
  inferToolMetadata,
  CORE_TOOL_NAMES,
  detectToolHints,
  type ToolMetadata,
  type RegistryTool,
} from './tool-registry';
import type { SessionManager } from '../sessions';
import type { Database } from '../db';
import {
  createAmazonAdapter,
  createEbayAdapter,
  createWalmartAdapter,
  createAliExpressAdapter,
  type PlatformAdapter,
  type ProductSearchResult,
} from '../platforms';
import { createListing, optimizeListing } from '../listing/creator';
import { recommendPrice } from '../listing/pricer';
import { calculateProfit, calculateFees } from '../arbitrage/calculator';
import { autoPurchase } from '../fulfillment/purchaser';
import { getTracking, updateTrackingOnPlatform } from '../fulfillment/tracker';
import { createEbaySellerApi } from '../platforms/ebay/seller';
import { createEbayOrdersApi } from '../platforms/ebay/orders';
import { createEbayAccountApi } from '../platforms/ebay/account';
import { createEbayTaxonomyApi } from '../platforms/ebay/taxonomy';
import { createAliExpressShippingApi } from '../platforms/aliexpress/shipping';
import { createAliExpressOrdersApi } from '../platforms/aliexpress/orders';
import { createAliExpressExtendedApi } from '../platforms/aliexpress/extended';
import { createWalmartExtendedApi } from '../platforms/walmart/extended';
import { createAmazonExtendedApi } from '../platforms/amazon/extended';
import { createAmazonSpApi } from '../platforms/amazon/sp-api';
import { createEbayFinancesApi } from '../platforms/ebay/finances';
import { createEbayAnalyticsApi } from '../platforms/ebay/analytics';
import { createEbayMarketingApi } from '../platforms/ebay/marketing';
import { createKeepaApi } from '../platforms/keepa';
import { createEasyPostApi } from '../platforms/easypost';
import { createWalmartSellerApi } from '../platforms/walmart/seller';

const logger = createLogger('agent');

// =============================================================================
// TYPES
// =============================================================================

/**
 * Credentials manager interface used by the agent.
 * Matches the synchronous API from credentials/index.ts.
 */
export interface CredentialsManager {
  getCredentials: <T = unknown>(userId: string, platform: Platform) => T | null;
  hasCredentials: (userId: string, platform: Platform) => boolean;
  listUserPlatforms: (userId: string) => Platform[];
  setCredentials?: (userId: string, platform: Platform, credentials: unknown) => void;
  deleteCredentials?: (userId: string, platform: Platform) => void;
}

/** Minimal skill manager interface (to be implemented in skills/loader.ts) */
export interface SkillManager {
  getSkillContext: (message?: string) => string;
  getCommands: () => Array<{ name: string; description: string }>;
  reload: () => void;
}

type JsonSchemaProperty = {
  type: string;
  description?: string;
  enum?: (string | number | boolean)[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
};

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  metadata?: ToolMetadata;
}

export interface AgentContext {
  session: Session;
  db: Database;
  sessionManager: SessionManager;
  skills: SkillManager;
  credentials: CredentialsManager;
  sendMessage: (msg: OutgoingMessage) => Promise<string | null>;
  addToHistory: (role: 'user' | 'assistant', content: string) => void;
  clearHistory: () => void;
}

export interface AgentManager {
  handleMessage: (message: IncomingMessage, session: Session) => Promise<string | null>;
  dispose: () => void;
  reloadSkills: () => void;
  reloadConfig: (config: Config) => void;
  getSkillCommands: () => Array<{ name: string; description: string }>;
}

// =============================================================================
// SYSTEM PROMPT
// =============================================================================

const SYSTEM_PROMPT = `You are FlipAgent, an AI assistant for e-commerce arbitrage.

You help users:
- Find price arbitrage opportunities across Amazon, eBay, Walmart, and AliExpress
- Auto-create optimized listings on selling platforms
- Monitor and fulfill orders via dropshipping
- Track profit, margins, and ROI across all operations
- Manage platform credentials and API keys

Be concise and direct. Use data when available. Format currency as $XX.XX.
When presenting margins, use percentage format (e.g., "32% margin").

{{SKILLS}}

Available platforms: amazon, ebay, walmart, aliexpress

Keep responses concise but informative.`;

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

function defineTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    // -------------------------------------------------------------------------
    // Scanner tools
    // -------------------------------------------------------------------------
    {
      name: 'scan_amazon',
      description: 'Search Amazon for products by keyword. Returns product listings with prices, ratings, and availability.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g., "wireless earbuds", "yoga mat")' },
          category: { type: 'string', description: 'Amazon category to narrow results' },
          maxResults: { type: 'number', description: 'Maximum number of results (default: 10)', default: 10 },
        },
        required: ['query'],
      },
    },
    {
      name: 'scan_ebay',
      description: 'Search eBay for products by keyword. Returns listings with prices, seller ratings, and shipping info.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          category: { type: 'string', description: 'eBay category to narrow results' },
          maxResults: { type: 'number', description: 'Maximum number of results (default: 10)', default: 10 },
        },
        required: ['query'],
      },
    },
    {
      name: 'scan_walmart',
      description: 'Search Walmart for products by keyword. Returns product listings with prices and availability.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          category: { type: 'string', description: 'Walmart category to narrow results' },
          maxResults: { type: 'number', description: 'Maximum number of results (default: 10)', default: 10 },
        },
        required: ['query'],
      },
    },
    {
      name: 'scan_aliexpress',
      description: 'Search AliExpress for products by keyword. Returns listings with prices, seller ratings, and shipping times.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          category: { type: 'string', description: 'AliExpress category to narrow results' },
          maxResults: { type: 'number', description: 'Maximum number of results (default: 10)', default: 10 },
        },
        required: ['query'],
      },
    },
    {
      name: 'compare_prices',
      description: 'Compare prices for a product across all platforms. Finds the cheapest source and best selling price.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product name or search query' },
          upc: { type: 'string', description: 'UPC barcode for exact matching' },
          asin: { type: 'string', description: 'Amazon ASIN for exact matching' },
          platforms: {
            type: 'array',
            description: 'Platforms to compare (default: all)',
            items: { type: 'string', enum: ['amazon', 'ebay', 'walmart', 'aliexpress'] },
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'find_arbitrage',
      description: 'Find arbitrage opportunities with positive margins. Scans across platforms for price gaps.',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Product category to focus on' },
          minMargin: { type: 'number', description: 'Minimum profit margin % (default: 15)', default: 15 },
          maxResults: { type: 'number', description: 'Maximum number of opportunities (default: 10)', default: 10 },
        },
      },
    },
    {
      name: 'match_products',
      description: 'Match a product across platforms using UPC, title, or other identifiers. Returns the same product on different platforms.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product name or identifier' },
          upc: { type: 'string', description: 'UPC barcode for exact matching' },
          platforms: {
            type: 'array',
            description: 'Platforms to search (default: all)',
            items: { type: 'string', enum: ['amazon', 'ebay', 'walmart', 'aliexpress'] },
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_product_details',
      description: 'Get detailed product information from a specific platform including description, images, specifications, and current price.',
      input_schema: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Platform name', enum: ['amazon', 'ebay', 'walmart', 'aliexpress'] },
          productId: { type: 'string', description: 'Platform-specific product ID (ASIN, eBay item ID, etc.)' },
        },
        required: ['platform', 'productId'],
      },
    },
    {
      name: 'check_stock',
      description: 'Check current stock availability for a product on a specific platform.',
      input_schema: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Platform name', enum: ['amazon', 'ebay', 'walmart', 'aliexpress'] },
          productId: { type: 'string', description: 'Platform-specific product ID' },
        },
        required: ['platform', 'productId'],
      },
    },
    {
      name: 'get_price_history',
      description: 'Get historical price data for a product. Shows price trends over time.',
      input_schema: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Internal product ID' },
          platform: { type: 'string', description: 'Filter to specific platform', enum: ['amazon', 'ebay', 'walmart', 'aliexpress'] },
          days: { type: 'number', description: 'Number of days of history (default: 30)', default: 30 },
        },
        required: ['productId'],
      },
    },

    // -------------------------------------------------------------------------
    // Listing tools
    // -------------------------------------------------------------------------
    {
      name: 'create_ebay_listing',
      description: 'Create a new eBay listing for a product. Auto-optimizes title and description for search visibility.',
      input_schema: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Internal product ID to list' },
          title: { type: 'string', description: 'Listing title (max 80 chars for eBay)' },
          price: { type: 'number', description: 'Listing price in USD' },
          description: { type: 'string', description: 'HTML or plain text description' },
          category: { type: 'string', description: 'eBay category ID or name' },
        },
        required: ['productId', 'title', 'price'],
      },
    },
    {
      name: 'create_amazon_listing',
      description: 'Create a new Amazon listing or offer for an existing product.',
      input_schema: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Internal product ID' },
          title: { type: 'string', description: 'Product title' },
          price: { type: 'number', description: 'Listing price in USD' },
          asin: { type: 'string', description: 'ASIN to list against (existing product)' },
        },
        required: ['productId', 'title', 'price'],
      },
    },
    {
      name: 'update_listing_price',
      description: 'Update the price of an existing listing on any platform.',
      input_schema: {
        type: 'object',
        properties: {
          listingId: { type: 'string', description: 'Internal listing ID' },
          newPrice: { type: 'number', description: 'New price in USD' },
        },
        required: ['listingId', 'newPrice'],
      },
    },
    {
      name: 'optimize_listing',
      description: 'Optimize an existing listing by improving title, description, and keywords for better search ranking.',
      input_schema: {
        type: 'object',
        properties: {
          listingId: { type: 'string', description: 'Internal listing ID to optimize' },
        },
        required: ['listingId'],
      },
    },
    {
      name: 'bulk_list',
      description: 'Create listings for multiple arbitrage opportunities at once.',
      input_schema: {
        type: 'object',
        properties: {
          opportunityIds: {
            type: 'array',
            description: 'Array of opportunity IDs to create listings for',
            items: { type: 'string' },
          },
        },
        required: ['opportunityIds'],
      },
    },
    {
      name: 'pause_listing',
      description: 'Pause an active listing (temporarily hide from buyers).',
      input_schema: {
        type: 'object',
        properties: {
          listingId: { type: 'string', description: 'Internal listing ID to pause' },
        },
        required: ['listingId'],
      },
    },
    {
      name: 'resume_listing',
      description: 'Resume a paused listing (make visible to buyers again).',
      input_schema: {
        type: 'object',
        properties: {
          listingId: { type: 'string', description: 'Internal listing ID to resume' },
        },
        required: ['listingId'],
      },
    },
    {
      name: 'delete_listing',
      description: 'Permanently delete a listing from the selling platform.',
      input_schema: {
        type: 'object',
        properties: {
          listingId: { type: 'string', description: 'Internal listing ID to delete' },
        },
        required: ['listingId'],
      },
    },

    // -------------------------------------------------------------------------
    // Fulfillment tools
    // -------------------------------------------------------------------------
    {
      name: 'check_orders',
      description: 'Check current orders and their statuses. Filter by status or platform.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by order status', enum: ['pending', 'purchased', 'shipped', 'delivered', 'returned'] },
          platform: { type: 'string', description: 'Filter by selling platform', enum: ['amazon', 'ebay', 'walmart', 'aliexpress'] },
        },
      },
    },
    {
      name: 'auto_purchase',
      description: 'Automatically purchase a product from the source platform to fulfill an order.',
      input_schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'Order ID to fulfill' },
        },
        required: ['orderId'],
      },
    },
    {
      name: 'track_shipment',
      description: 'Get shipping tracking information for an order.',
      input_schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'Order ID to track' },
        },
        required: ['orderId'],
      },
    },
    {
      name: 'update_tracking',
      description: 'Update tracking information for an order on the selling platform.',
      input_schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'Order ID to update' },
          trackingNumber: { type: 'string', description: 'Shipping tracking number' },
          carrier: { type: 'string', description: 'Shipping carrier (e.g., USPS, UPS, FedEx)' },
        },
        required: ['orderId', 'trackingNumber'],
      },
    },
    {
      name: 'handle_return',
      description: 'Process a return request for an order.',
      input_schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'Order ID for the return' },
          reason: { type: 'string', description: 'Reason for the return' },
        },
        required: ['orderId'],
      },
    },
    {
      name: 'calculate_profit',
      description: 'Calculate profit for a specific order or over a date range, accounting for all fees and costs.',
      input_schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'Specific order ID to calculate profit for' },
          dateRange: { type: 'string', description: 'Date range string (e.g., "7d", "30d", "2024-01-01..2024-01-31")' },
        },
      },
    },

    // -------------------------------------------------------------------------
    // Analytics tools
    // -------------------------------------------------------------------------
    {
      name: 'daily_report',
      description: 'Generate a daily summary report of all activity: scans, listings, orders, and profit.',
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date for the report (YYYY-MM-DD, default: today)' },
        },
      },
    },
    {
      name: 'profit_dashboard',
      description: 'Show profit dashboard with revenue, costs, fees, and net profit for a given period.',
      input_schema: {
        type: 'object',
        properties: {
          period: { type: 'string', description: 'Time period (e.g., "7d", "30d", "mtd", "ytd")', default: '7d' },
        },
      },
    },
    {
      name: 'top_opportunities',
      description: 'Show the top current arbitrage opportunities ranked by estimated profit margin.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of opportunities to show (default: 10)', default: 10 },
          minMargin: { type: 'number', description: 'Minimum margin % to include', default: 10 },
        },
      },
    },
    {
      name: 'category_analysis',
      description: 'Analyze profitability and opportunity density by product category.',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Specific category to analyze (default: all categories)' },
        },
      },
    },
    {
      name: 'competitor_watch',
      description: 'Monitor competitor pricing and activity for a product or across a platform.',
      input_schema: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Product ID to monitor competitors for' },
          platform: { type: 'string', description: 'Platform to monitor', enum: ['amazon', 'ebay', 'walmart', 'aliexpress'] },
        },
      },
    },
    {
      name: 'fee_calculator',
      description: 'Calculate estimated platform fees for selling a product at a given price.',
      input_schema: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Selling platform', enum: ['amazon', 'ebay', 'walmart', 'aliexpress'] },
          price: { type: 'number', description: 'Selling price in USD' },
          category: { type: 'string', description: 'Product category (affects fee rates)' },
          shipping: { type: 'number', description: 'Shipping cost in USD', default: 0 },
        },
        required: ['platform', 'price'],
      },
    },

    // -------------------------------------------------------------------------
    // Credential tools (core)
    // -------------------------------------------------------------------------
    {
      name: 'setup_amazon_credentials',
      description: 'Store Amazon Product Advertising API credentials for product scanning and listing.',
      input_schema: {
        type: 'object',
        properties: {
          accessKeyId: { type: 'string', description: 'Amazon PA-API Access Key ID' },
          secretAccessKey: { type: 'string', description: 'Amazon PA-API Secret Access Key' },
          partnerTag: { type: 'string', description: 'Amazon Associates partner tag' },
          marketplace: { type: 'string', description: 'Amazon marketplace (default: US)', default: 'US' },
        },
        required: ['accessKeyId', 'secretAccessKey', 'partnerTag'],
      },
    },
    {
      name: 'setup_ebay_credentials',
      description: 'Store eBay API credentials for listing and order management.',
      input_schema: {
        type: 'object',
        properties: {
          clientId: { type: 'string', description: 'eBay API Client ID (App ID)' },
          clientSecret: { type: 'string', description: 'eBay API Client Secret (Cert ID)' },
          refreshToken: { type: 'string', description: 'eBay OAuth refresh token' },
          environment: { type: 'string', description: 'API environment', enum: ['sandbox', 'production'], default: 'production' },
        },
        required: ['clientId', 'clientSecret', 'refreshToken'],
      },
    },
    {
      name: 'setup_walmart_credentials',
      description: 'Store Walmart API credentials for product scanning.',
      input_schema: {
        type: 'object',
        properties: {
          clientId: { type: 'string', description: 'Walmart API Client ID' },
          clientSecret: { type: 'string', description: 'Walmart API Client Secret' },
        },
        required: ['clientId', 'clientSecret'],
      },
    },
    {
      name: 'setup_aliexpress_credentials',
      description: 'Store AliExpress API credentials for product scanning and sourcing.',
      input_schema: {
        type: 'object',
        properties: {
          appKey: { type: 'string', description: 'AliExpress App Key' },
          appSecret: { type: 'string', description: 'AliExpress App Secret' },
        },
        required: ['appKey', 'appSecret'],
      },
    },
    {
      name: 'list_credentials',
      description: 'List all configured platform credentials (shows platforms, not secrets).',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'delete_credentials',
      description: 'Delete stored credentials for a platform.',
      input_schema: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Platform to delete credentials for', enum: ['amazon', 'ebay', 'walmart', 'aliexpress'] },
        },
        required: ['platform'],
      },
    },

    // -------------------------------------------------------------------------
    // Extended platform tools
    // -------------------------------------------------------------------------
    {
      name: 'get_shipping_cost',
      description: 'Get shipping cost estimates for an AliExpress product to a destination country.',
      input_schema: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'AliExpress product ID' },
          country: { type: 'string', description: 'Destination country code (e.g., US, GB, DE)', default: 'US' },
          quantity: { type: 'number', description: 'Number of items', default: 1 },
        },
        required: ['productId'],
      },
    },
    {
      name: 'get_hot_products',
      description: 'Get trending/hot products from AliExpress. Useful for finding popular items with high demand.',
      input_schema: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: 'Keywords to filter hot products' },
          categoryId: { type: 'string', description: 'AliExpress category ID' },
          minPrice: { type: 'number', description: 'Minimum price filter' },
          maxPrice: { type: 'number', description: 'Maximum price filter' },
          sort: { type: 'string', description: 'Sort order', enum: ['SALE_PRICE_ASC', 'SALE_PRICE_DESC', 'LAST_VOLUME_ASC', 'LAST_VOLUME_DESC'] },
          maxResults: { type: 'number', description: 'Maximum results (default: 20)', default: 20 },
        },
      },
    },
    {
      name: 'get_aliexpress_categories',
      description: 'Get the full list of AliExpress product categories for browsing and filtering.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_product_variations',
      description: 'Get all variations (sizes, colors, etc.) for an Amazon product by ASIN.',
      input_schema: {
        type: 'object',
        properties: {
          asin: { type: 'string', description: 'Amazon ASIN to get variations for' },
          marketplace: { type: 'string', description: 'Amazon marketplace (default: US)', default: 'US' },
        },
        required: ['asin'],
      },
    },
    {
      name: 'browse_amazon_categories',
      description: 'Browse Amazon category tree by browse node IDs. Shows parent/child categories.',
      input_schema: {
        type: 'object',
        properties: {
          nodeIds: {
            type: 'array',
            description: 'Amazon browse node IDs to look up',
            items: { type: 'string' },
          },
          marketplace: { type: 'string', description: 'Amazon marketplace (default: US)', default: 'US' },
        },
        required: ['nodeIds'],
      },
    },
    {
      name: 'ebay_get_policies',
      description: 'Get eBay seller business policies (fulfillment, payment, return). Required for creating listings.',
      input_schema: {
        type: 'object',
        properties: {
          policyType: { type: 'string', description: 'Type of policy to retrieve', enum: ['fulfillment', 'payment', 'return', 'all'] },
          marketplaceId: { type: 'string', description: 'eBay marketplace (default: EBAY_US)', default: 'EBAY_US' },
        },
      },
    },
    {
      name: 'ebay_create_policy',
      description: 'Create an eBay business policy (fulfillment, payment, or return).',
      input_schema: {
        type: 'object',
        properties: {
          policyType: { type: 'string', description: 'Type of policy', enum: ['fulfillment', 'payment', 'return'] },
          name: { type: 'string', description: 'Policy name' },
          handlingTimeDays: { type: 'number', description: 'Handling time in days (fulfillment only)' },
          shippingServiceCode: { type: 'string', description: 'Shipping service code (fulfillment only)', default: 'ShippingMethodStandard' },
          freeShipping: { type: 'boolean', description: 'Offer free shipping (fulfillment only)' },
          returnsAccepted: { type: 'boolean', description: 'Accept returns (return policy only)', default: true },
          returnDays: { type: 'number', description: 'Return window in days (return only)', default: 30 },
        },
        required: ['policyType', 'name'],
      },
    },
    {
      name: 'ebay_category_suggest',
      description: 'Get eBay category suggestions for a product query. Helps pick the right category for listings.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product description or title to get category suggestions for' },
        },
        required: ['query'],
      },
    },
    {
      name: 'ebay_item_aspects',
      description: 'Get required and recommended item aspects (specifics) for an eBay category.',
      input_schema: {
        type: 'object',
        properties: {
          categoryId: { type: 'string', description: 'eBay category ID to get aspects for' },
        },
        required: ['categoryId'],
      },
    },
    {
      name: 'ebay_get_inventory',
      description: 'List current eBay inventory items with pagination.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max items to return (default: 25)', default: 25 },
          offset: { type: 'number', description: 'Offset for pagination', default: 0 },
        },
      },
    },
    {
      name: 'ebay_bulk_update',
      description: 'Bulk update prices and/or quantities for multiple eBay listings at once.',
      input_schema: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            description: 'Array of updates with sku, offerId, and optional price/quantity',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string', description: 'SKU of the item' },
                offerId: { type: 'string', description: 'eBay offer ID' },
                price: { type: 'number', description: 'New price in USD' },
                quantity: { type: 'number', description: 'New quantity' },
              },
              required: ['sku', 'offerId'],
            },
          },
        },
        required: ['updates'],
      },
    },
    {
      name: 'ebay_issue_refund',
      description: 'Issue a refund for an eBay order.',
      input_schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'eBay order ID' },
          reason: { type: 'string', description: 'Reason for refund', enum: ['BUYER_CANCEL', 'ITEM_NOT_RECEIVED', 'ITEM_NOT_AS_DESCRIBED', 'OTHER'] },
          amount: { type: 'number', description: 'Refund amount (optional, full refund if omitted)' },
          comment: { type: 'string', description: 'Comment for the buyer' },
        },
        required: ['orderId', 'reason'],
      },
    },
    {
      name: 'walmart_upc_lookup',
      description: 'Look up a Walmart product by UPC barcode for exact matching.',
      input_schema: {
        type: 'object',
        properties: {
          upc: { type: 'string', description: 'UPC barcode to look up' },
        },
        required: ['upc'],
      },
    },
    {
      name: 'walmart_trending',
      description: 'Get trending/popular products on Walmart.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'walmart_taxonomy',
      description: 'Get Walmart product category taxonomy for browsing and filtering.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_ds_order_status',
      description: 'Check the status of an AliExpress dropshipping order.',
      input_schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'AliExpress order ID' },
        },
        required: ['orderId'],
      },
    },

    // -------------------------------------------------------------------------
    // Amazon SP-API tools (Selling Partner API)
    // -------------------------------------------------------------------------
    {
      name: 'amazon_sp_search_catalog',
      description: 'Search Amazon product catalog via SP-API. Returns detailed catalog data including sales rank, images, brand.',
      input_schema: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: 'Search keywords' },
          identifiers: { type: 'string', description: 'Comma-separated ASINs, UPCs, or EANs for exact lookup' },
          identifiersType: { type: 'string', description: 'Type of identifiers', enum: ['ASIN', 'UPC', 'EAN', 'ISBN'] },
          maxResults: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        },
      },
    },
    {
      name: 'amazon_sp_get_pricing',
      description: 'Get competitive pricing and buy box data for Amazon ASINs. Essential for arbitrage price comparison.',
      input_schema: {
        type: 'object',
        properties: {
          asins: { type: 'string', description: 'Comma-separated ASINs (max 20)' },
        },
        required: ['asins'],
      },
    },
    {
      name: 'amazon_sp_estimate_fees',
      description: 'Estimate Amazon seller fees (FBA/FBM) for a product at a given price. Critical for profit calculations.',
      input_schema: {
        type: 'object',
        properties: {
          asin: { type: 'string', description: 'Amazon ASIN' },
          price: { type: 'number', description: 'Listing price in USD' },
          shipping: { type: 'number', description: 'Shipping price (default: 0)', default: 0 },
          fba: { type: 'boolean', description: 'Use FBA fulfillment (default: false)', default: false },
        },
        required: ['asin', 'price'],
      },
    },
    {
      name: 'amazon_sp_create_listing',
      description: 'Create or update an Amazon listing via SP-API Listings Items API.',
      input_schema: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Your seller SKU' },
          productType: { type: 'string', description: 'Amazon product type (e.g., PRODUCT)' },
          title: { type: 'string', description: 'Product title' },
          price: { type: 'number', description: 'Listing price in USD' },
          condition: { type: 'string', description: 'Condition', enum: ['new_new', 'new_open_box', 'used_like_new', 'used_very_good', 'used_good', 'used_acceptable'] },
          quantity: { type: 'number', description: 'Available quantity', default: 1 },
        },
        required: ['sku', 'productType'],
      },
    },
    {
      name: 'amazon_sp_get_orders',
      description: 'Get Amazon seller orders (recent or filtered by status/date).',
      input_schema: {
        type: 'object',
        properties: {
          createdAfter: { type: 'string', description: 'ISO date (default: last 7 days)' },
          orderStatuses: { type: 'string', description: 'Comma-separated: Pending,Unshipped,PartiallyShipped,Shipped,Canceled' },
          maxResults: { type: 'number', description: 'Max results (default: 50)', default: 50 },
        },
      },
    },
    {
      name: 'amazon_sp_get_fba_inventory',
      description: 'Get FBA inventory summaries showing fulfillable quantities, inbound, and receiving stock.',
      input_schema: {
        type: 'object',
        properties: {
          sellerSkus: { type: 'string', description: 'Comma-separated seller SKUs to filter (optional)' },
        },
      },
    },

    // -------------------------------------------------------------------------
    // eBay Finances / Analytics / Marketing
    // -------------------------------------------------------------------------
    {
      name: 'ebay_get_transactions',
      description: 'Get eBay seller transaction history — sales, refunds, fees. Essential for P&L tracking.',
      input_schema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'eBay filter string (e.g., "transactionType={SALE}")' },
          sort: { type: 'string', description: 'Sort (e.g., "transactionDate")' },
          limit: { type: 'number', description: 'Max results (default: 50)', default: 50 },
        },
      },
    },
    {
      name: 'ebay_get_payouts',
      description: 'Get eBay payout history — when money was sent to your bank account.',
      input_schema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'eBay filter string' },
          limit: { type: 'number', description: 'Max results (default: 50)', default: 50 },
        },
      },
    },
    {
      name: 'ebay_funds_summary',
      description: 'Get eBay seller funds summary — available balance, funds on hold, processing.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'ebay_traffic_report',
      description: 'Get eBay seller traffic analytics — views, impressions, click-through rate, conversion rate.',
      input_schema: {
        type: 'object',
        properties: {
          dimension: { type: 'string', description: 'Report dimension', enum: ['DAY', 'LISTING'], default: 'DAY' },
          dateRange: { type: 'string', description: 'Date range filter (e.g., "date_range=[2026-01-01..2026-02-01]")' },
          metrics: { type: 'string', description: 'Comma-separated metrics (default: CLICK_THROUGH_RATE,LISTING_VIEWS_TOTAL,SALES_CONVERSION_RATE,TRANSACTION)', default: 'CLICK_THROUGH_RATE,LISTING_VIEWS_TOTAL,SALES_CONVERSION_RATE,TRANSACTION' },
        },
      },
    },
    {
      name: 'ebay_seller_metrics',
      description: 'Get eBay seller performance metrics — defect rate, late shipment rate, INR rate.',
      input_schema: {
        type: 'object',
        properties: {
          metricType: { type: 'string', description: 'Metric type', enum: ['ITEM_NOT_AS_DESCRIBED', 'ITEM_NOT_RECEIVED'] },
          evaluationType: { type: 'string', description: 'Evaluation', enum: ['CURRENT', 'PROJECTED'], default: 'CURRENT' },
        },
        required: ['metricType'],
      },
    },
    {
      name: 'ebay_create_campaign',
      description: 'Create an eBay Promoted Listings campaign to boost visibility. Costs only when items sell.',
      input_schema: {
        type: 'object',
        properties: {
          campaignName: { type: 'string', description: 'Campaign name' },
          bidPercentage: { type: 'string', description: 'Ad rate % (default: 5.0)', default: '5.0' },
          fundingModel: { type: 'string', description: 'Billing model', enum: ['COST_PER_SALE', 'COST_PER_CLICK'], default: 'COST_PER_SALE' },
        },
        required: ['campaignName'],
      },
    },
    {
      name: 'ebay_get_campaigns',
      description: 'List eBay Promoted Listings campaigns with status.',
      input_schema: {
        type: 'object',
        properties: {
          campaignStatus: { type: 'string', description: 'Filter by status (RUNNING, PAUSED, ENDED)' },
        },
      },
    },
    {
      name: 'ebay_promote_listings',
      description: 'Add listings to an eBay Promoted Listings campaign (bulk).',
      input_schema: {
        type: 'object',
        properties: {
          campaignId: { type: 'string', description: 'Campaign ID' },
          listingIds: { type: 'string', description: 'Comma-separated eBay listing IDs to promote' },
          bidPercentage: { type: 'string', description: 'Ad rate % (default: 5.0)', default: '5.0' },
        },
        required: ['campaignId', 'listingIds'],
      },
    },

    // -------------------------------------------------------------------------
    // Keepa — Amazon price intelligence
    // -------------------------------------------------------------------------
    {
      name: 'keepa_price_history',
      description: 'Get Amazon price history from Keepa — current, avg 30/90/180 day, all-time min/max. Critical for buy decisions.',
      input_schema: {
        type: 'object',
        properties: {
          asin: { type: 'string', description: 'Amazon ASIN (or comma-separated ASINs)' },
          history: { type: 'boolean', description: 'Include full price history chart data (default: true)', default: true },
        },
        required: ['asin'],
      },
    },
    {
      name: 'keepa_deals',
      description: 'Find current Amazon price drops/deals via Keepa. Great for sourcing arbitrage opportunities.',
      input_schema: {
        type: 'object',
        properties: {
          minPercentOff: { type: 'number', description: 'Minimum % price drop (default: 20)', default: 20 },
          maxPercentOff: { type: 'number', description: 'Maximum % price drop (default: 90)', default: 90 },
          categoryIds: { type: 'string', description: 'Comma-separated Keepa category IDs to filter' },
        },
      },
    },
    {
      name: 'keepa_bestsellers',
      description: 'Get Amazon bestseller ASINs for a category via Keepa.',
      input_schema: {
        type: 'object',
        properties: {
          categoryId: { type: 'number', description: 'Keepa category ID' },
        },
        required: ['categoryId'],
      },
    },
    {
      name: 'keepa_track_product',
      description: 'Set up a Keepa price alert for an Amazon product. Get notified when price drops below threshold.',
      input_schema: {
        type: 'object',
        properties: {
          asin: { type: 'string', description: 'Amazon ASIN to track' },
          targetPrice: { type: 'number', description: 'Alert when price drops below this (USD)' },
        },
        required: ['asin', 'targetPrice'],
      },
    },

    // -------------------------------------------------------------------------
    // EasyPost — Shipping labels + tracking
    // -------------------------------------------------------------------------
    {
      name: 'get_shipping_rates',
      description: 'Compare shipping rates across carriers (USPS, UPS, FedEx) for a package. Returns cheapest options.',
      input_schema: {
        type: 'object',
        properties: {
          fromZip: { type: 'string', description: 'Origin ZIP code' },
          fromCity: { type: 'string', description: 'Origin city' },
          fromState: { type: 'string', description: 'Origin state (2-letter)' },
          toZip: { type: 'string', description: 'Destination ZIP code' },
          toCity: { type: 'string', description: 'Destination city' },
          toState: { type: 'string', description: 'Destination state (2-letter)' },
          toCountry: { type: 'string', description: 'Destination country (default: US)', default: 'US' },
          weightOz: { type: 'number', description: 'Package weight in ounces' },
          lengthIn: { type: 'number', description: 'Package length in inches' },
          widthIn: { type: 'number', description: 'Package width in inches' },
          heightIn: { type: 'number', description: 'Package height in inches' },
        },
        required: ['fromZip', 'toZip', 'weightOz'],
      },
    },
    {
      name: 'buy_shipping_label',
      description: 'Purchase a shipping label at a previously quoted rate. Returns label URL and tracking number.',
      input_schema: {
        type: 'object',
        properties: {
          shipmentId: { type: 'string', description: 'EasyPost shipment ID from get_shipping_rates' },
          rateId: { type: 'string', description: 'Rate ID to purchase' },
        },
        required: ['shipmentId', 'rateId'],
      },
    },
    {
      name: 'track_package',
      description: 'Track any package across all carriers (USPS, UPS, FedEx, DHL, etc.) using EasyPost universal tracking.',
      input_schema: {
        type: 'object',
        properties: {
          trackingCode: { type: 'string', description: 'Tracking number' },
          carrier: { type: 'string', description: 'Carrier name (auto-detected if omitted)' },
        },
        required: ['trackingCode'],
      },
    },
    {
      name: 'verify_address',
      description: 'Verify a shipping address via USPS. Returns corrected address with delivery verification.',
      input_schema: {
        type: 'object',
        properties: {
          street1: { type: 'string', description: 'Street address line 1' },
          street2: { type: 'string', description: 'Street address line 2' },
          city: { type: 'string', description: 'City' },
          state: { type: 'string', description: 'State (2-letter)' },
          zip: { type: 'string', description: 'ZIP code' },
          country: { type: 'string', description: 'Country (default: US)', default: 'US' },
        },
        required: ['street1', 'city', 'state', 'zip'],
      },
    },

    // -------------------------------------------------------------------------
    // Credential setup for new services
    // -------------------------------------------------------------------------
    {
      name: 'setup_amazon_sp_credentials',
      description: 'Configure Amazon SP-API (Selling Partner API) credentials for seller operations.',
      input_schema: {
        type: 'object',
        properties: {
          spClientId: { type: 'string', description: 'LWA client ID' },
          spClientSecret: { type: 'string', description: 'LWA client secret' },
          spRefreshToken: { type: 'string', description: 'LWA refresh token' },
        },
        required: ['spClientId', 'spClientSecret', 'spRefreshToken'],
      },
    },
    {
      name: 'setup_keepa_credentials',
      description: 'Configure Keepa API key for Amazon price history tracking.',
      input_schema: {
        type: 'object',
        properties: {
          apiKey: { type: 'string', description: 'Keepa API key' },
        },
        required: ['apiKey'],
      },
    },
    {
      name: 'setup_easypost_credentials',
      description: 'Configure EasyPost API key for shipping labels and tracking.',
      input_schema: {
        type: 'object',
        properties: {
          apiKey: { type: 'string', description: 'EasyPost API key' },
        },
        required: ['apiKey'],
      },
    },

    // -------------------------------------------------------------------------
    // Walmart Marketplace seller tools
    // -------------------------------------------------------------------------
    {
      name: 'walmart_get_seller_items',
      description: 'Get your Walmart Marketplace seller items. Lists your catalog with publish status and pricing.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max items to return (default: 20)', default: 20 },
          offset: { type: 'number', description: 'Offset for pagination', default: 0 },
        },
      },
    },
    {
      name: 'walmart_update_price',
      description: 'Update pricing for a Walmart Marketplace item by SKU.',
      input_schema: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Walmart seller SKU' },
          price: { type: 'number', description: 'New price in USD' },
        },
        required: ['sku', 'price'],
      },
    },
    {
      name: 'walmart_update_inventory',
      description: 'Update inventory quantity for a Walmart Marketplace item by SKU.',
      input_schema: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Walmart seller SKU' },
          quantity: { type: 'number', description: 'New inventory quantity' },
        },
        required: ['sku', 'quantity'],
      },
    },
    {
      name: 'walmart_get_orders',
      description: 'Get Walmart Marketplace orders. Filter by status and date.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Order status filter', enum: ['Created', 'Acknowledged', 'Shipped', 'Delivered', 'Cancelled'] },
          createdStartDate: { type: 'string', description: 'Start date (ISO format, e.g. 2026-01-01)' },
          limit: { type: 'number', description: 'Max orders (default: 50)', default: 50 },
        },
      },
    },
    {
      name: 'walmart_ship_order',
      description: 'Ship a Walmart Marketplace order with tracking information.',
      input_schema: {
        type: 'object',
        properties: {
          purchaseOrderId: { type: 'string', description: 'Walmart purchase order ID' },
          carrier: { type: 'string', description: 'Shipping carrier (e.g. USPS, UPS, FedEx)' },
          trackingNumber: { type: 'string', description: 'Tracking number' },
          methodCode: { type: 'string', description: 'Shipping method code (e.g. Standard, Express)', default: 'Standard' },
        },
        required: ['purchaseOrderId', 'carrier', 'trackingNumber'],
      },
    },
    {
      name: 'walmart_retire_item',
      description: 'Retire (delist) an item from your Walmart Marketplace store.',
      input_schema: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Walmart seller SKU to retire' },
        },
        required: ['sku'],
      },
    },
    {
      name: 'walmart_get_inventory',
      description: 'Get current inventory quantity for a Walmart Marketplace item.',
      input_schema: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Walmart seller SKU' },
        },
        required: ['sku'],
      },
    },

    // -------------------------------------------------------------------------
    // Cross-platform utility tools
    // -------------------------------------------------------------------------
    {
      name: 'batch_reprice',
      description: 'Batch update prices for multiple listings. Adjusts prices based on competitor data or fixed amounts.',
      input_schema: {
        type: 'object',
        properties: {
          strategy: { type: 'string', description: 'Repricing strategy', enum: ['undercut', 'match', 'fixed_margin', 'manual'] },
          undercutAmount: { type: 'number', description: 'Amount to undercut competitors by (for undercut strategy)', default: 0.01 },
          marginPct: { type: 'number', description: 'Target margin percentage (for fixed_margin strategy)', default: 20 },
          listingIds: { type: 'string', description: 'Comma-separated listing IDs to reprice (blank = all active)' },
        },
        required: ['strategy'],
      },
    },
    {
      name: 'inventory_sync',
      description: 'Sync inventory levels across platforms. Checks source product stock and updates listing quantities.',
      input_schema: {
        type: 'object',
        properties: {
          listingIds: { type: 'string', description: 'Comma-separated listing IDs to sync (blank = all active)' },
        },
      },
    },
    {
      name: 'setup_walmart_seller_credentials',
      description: 'Configure Walmart Marketplace seller credentials (separate from Affiliate API). Uses OAuth 2.0 client credentials.',
      input_schema: {
        type: 'object',
        properties: {
          clientId: { type: 'string', description: 'Walmart Marketplace OAuth client ID' },
          clientSecret: { type: 'string', description: 'Walmart Marketplace OAuth client secret' },
        },
        required: ['clientId', 'clientSecret'],
      },
    },

    // -------------------------------------------------------------------------
    // Meta tool (core)
    // -------------------------------------------------------------------------
    {
      name: 'tool_search',
      description: 'Search for available tools by name, platform, or category. Use this when you need a specialized tool that is not in your current set.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query describing what you need' },
          platform: { type: 'string', description: 'Filter by platform', enum: ['amazon', 'ebay', 'walmart', 'aliexpress'] },
          category: { type: 'string', description: 'Filter by category', enum: ['scanning', 'listing', 'fulfillment', 'analytics', 'pricing', 'admin'] },
        },
        required: ['query'],
      },
    },
  ];

  // Apply metadata to all tools
  for (const tool of tools) {
    const inferred = inferToolMetadata(tool.name, tool.description);
    tool.metadata = {
      ...inferred,
      core: CORE_TOOL_NAMES.has(tool.name),
    };
  }

  return tools;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Strip the `metadata` field from tools before sending to the Anthropic API.
 * The API does not accept unknown fields on tool definitions.
 */
function toApiTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map(({ metadata: _metadata, ...rest }) => rest as Anthropic.Tool);
}

/**
 * Select tools for the current message based on core tools + detected hints.
 * Caps at 50 tools to stay within Anthropic limits.
 */
function selectTools(
  registry: ToolRegistry<ToolDefinition>,
  messageText: string,
): ToolDefinition[] {
  const MAX_TOOLS = 50;
  const selected = new Map<string, ToolDefinition>();

  // Always include core tools
  for (const tool of registry.getCoreTools()) {
    selected.set(tool.name, tool);
  }

  // Detect hints from message text
  const hints = detectToolHints(messageText);

  // Add platform-matched tools
  for (const platform of hints.platforms) {
    for (const tool of registry.searchByPlatform(platform)) {
      if (selected.size >= MAX_TOOLS) break;
      selected.set(tool.name, tool);
    }
  }

  // Add category-matched tools
  for (const category of hints.categories) {
    for (const tool of registry.searchByCategory(category)) {
      if (selected.size >= MAX_TOOLS) break;
      selected.set(tool.name, tool);
    }
  }

  return Array.from(selected.values());
}

// =============================================================================
// TOOL EXECUTION — REAL PLATFORM INTEGRATIONS
// =============================================================================

/**
 * Get platform credentials for a user, returning typed credential objects.
 */
function getUserCreds(
  credentials: CredentialsManager,
  userId: string,
): {
  amazon?: AmazonCredentials;
  ebay?: EbayCredentials;
  walmart?: WalmartCredentials;
  aliexpress?: AliExpressCredentials;
  keepa?: KeepaCredentials;
  easypost?: EasyPostCredentials;
} {
  return {
    amazon: credentials.getCredentials<AmazonCredentials>(userId, 'amazon') ?? undefined,
    ebay: credentials.getCredentials<EbayCredentials>(userId, 'ebay') ?? undefined,
    walmart: credentials.getCredentials<WalmartCredentials>(userId, 'walmart') ?? undefined,
    aliexpress: credentials.getCredentials<AliExpressCredentials>(userId, 'aliexpress') ?? undefined,
    keepa: credentials.getCredentials<KeepaCredentials>(userId, 'amazon') ?? undefined, // stored under amazon
    easypost: credentials.getCredentials<EasyPostCredentials>(userId, 'ebay') ?? undefined, // stored under ebay for now
  };
}

/**
 * Create a platform adapter for a given platform using user's credentials.
 */
function getAdapter(platform: Platform, creds: ReturnType<typeof getUserCreds>): PlatformAdapter {
  switch (platform) {
    case 'amazon': return createAmazonAdapter(creds.amazon);
    case 'ebay': return createEbayAdapter(creds.ebay);
    case 'walmart': return createWalmartAdapter(creds.walmart);
    case 'aliexpress': return createAliExpressAdapter(creds.aliexpress);
  }
}

/**
 * Store search results in DB as products + price snapshots.
 */
function storeResults(db: Database, results: ProductSearchResult[]): void {
  const now = new Date();
  for (const r of results) {
    const productId = `${r.platform}:${r.platformId}`;
    db.upsertProduct({
      id: productId,
      title: r.title,
      upc: r.upc,
      asin: r.asin,
      brand: r.brand,
      category: r.category,
      imageUrl: r.imageUrl,
      createdAt: now,
      updatedAt: now,
    });
    db.addPrice({
      productId,
      platform: r.platform,
      platformId: r.platformId,
      price: r.price,
      shipping: r.shipping,
      currency: r.currency,
      inStock: r.inStock,
      seller: r.seller,
      url: r.url,
      fetchedAt: now,
    });
  }
}

/**
 * Execute a tool by name with the given input.
 * Wired to real platform API integrations via adapters.
 */
async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  context: {
    registry: ToolRegistry<ToolDefinition>;
    db: Database;
    credentials: CredentialsManager;
    userId: string;
  },
): Promise<unknown> {
  const creds = getUserCreds(context.credentials, context.userId);

  switch (toolName) {
    // -----------------------------------------------------------------------
    // Meta: tool_search
    // -----------------------------------------------------------------------
    case 'tool_search': {
      const results = context.registry.search({
        query: input.query as string | undefined,
        platform: input.platform as string | undefined,
        category: input.category as string | undefined,
      });
      return {
        tools: results.slice(0, 20).map(t => ({
          name: t.name,
          description: t.description,
          platform: t.metadata?.platform ?? 'general',
          category: t.metadata?.category ?? 'general',
        })),
        total: results.length,
      };
    }

    // -----------------------------------------------------------------------
    // Credentials
    // -----------------------------------------------------------------------
    case 'setup_amazon_credentials': {
      const credData = {
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        partnerTag: input.partnerTag,
        marketplace: input.marketplace ?? 'US',
      };
      if (context.credentials.setCredentials) {
        context.credentials.setCredentials(context.userId, 'amazon', credData);
      }
      return { status: 'ok', message: 'Amazon credentials saved and encrypted.' };
    }

    case 'setup_ebay_credentials': {
      const credData = {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        refreshToken: input.refreshToken,
        environment: input.environment ?? 'production',
      };
      if (context.credentials.setCredentials) {
        context.credentials.setCredentials(context.userId, 'ebay', credData);
      }
      return { status: 'ok', message: 'eBay credentials saved and encrypted.' };
    }

    case 'setup_walmart_credentials': {
      const credData = {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
      };
      if (context.credentials.setCredentials) {
        context.credentials.setCredentials(context.userId, 'walmart', credData);
      }
      return { status: 'ok', message: 'Walmart credentials saved and encrypted.' };
    }

    case 'setup_aliexpress_credentials': {
      const credData = {
        appKey: input.appKey,
        appSecret: input.appSecret,
      };
      if (context.credentials.setCredentials) {
        context.credentials.setCredentials(context.userId, 'aliexpress', credData);
      }
      return { status: 'ok', message: 'AliExpress credentials saved and encrypted.' };
    }

    case 'list_credentials': {
      const platforms = context.credentials.listUserPlatforms(context.userId);
      return {
        status: 'ok',
        platforms,
        message: platforms.length > 0
          ? `Configured platforms: ${platforms.join(', ')}`
          : 'No platform credentials configured yet.',
      };
    }

    case 'delete_credentials': {
      const platform = input.platform as Platform;
      if (context.credentials.deleteCredentials) {
        context.credentials.deleteCredentials(context.userId, platform);
      }
      return { status: 'ok', message: `Credentials for ${platform} deleted.` };
    }

    // -----------------------------------------------------------------------
    // Scanners — Real API calls
    // -----------------------------------------------------------------------
    case 'scan_amazon': {
      if (!creds.amazon) {
        return { status: 'error', message: 'Amazon credentials not configured. Use setup_amazon_credentials first.' };
      }
      const adapter = createAmazonAdapter(creds.amazon);
      const results = await adapter.search({
        query: input.query as string,
        category: input.category as string | undefined,
        maxResults: typeof input.maxResults === 'number' ? input.maxResults : 10,
      });
      storeResults(context.db, results);
      return { status: 'ok', results, count: results.length };
    }

    case 'scan_ebay': {
      if (!creds.ebay) {
        return { status: 'error', message: 'eBay credentials not configured. Use setup_ebay_credentials first.' };
      }
      const adapter = createEbayAdapter(creds.ebay);
      const results = await adapter.search({
        query: input.query as string,
        category: input.category as string | undefined,
        maxResults: typeof input.maxResults === 'number' ? input.maxResults : 10,
      });
      storeResults(context.db, results);
      return { status: 'ok', results, count: results.length };
    }

    case 'scan_walmart': {
      if (!creds.walmart) {
        return { status: 'error', message: 'Walmart credentials not configured. Use setup_walmart_credentials first.' };
      }
      const adapter = createWalmartAdapter(creds.walmart);
      const results = await adapter.search({
        query: input.query as string,
        category: input.category as string | undefined,
        maxResults: typeof input.maxResults === 'number' ? input.maxResults : 10,
      });
      storeResults(context.db, results);
      return { status: 'ok', results, count: results.length };
    }

    case 'scan_aliexpress': {
      if (!creds.aliexpress) {
        return { status: 'error', message: 'AliExpress credentials not configured. Use setup_aliexpress_credentials first.' };
      }
      const adapter = createAliExpressAdapter(creds.aliexpress);
      const results = await adapter.search({
        query: input.query as string,
        category: input.category as string | undefined,
        maxResults: typeof input.maxResults === 'number' ? input.maxResults : 10,
      });
      storeResults(context.db, results);
      return { status: 'ok', results, count: results.length };
    }

    case 'compare_prices': {
      const query = input.query as string;
      const targetPlatforms = (input.platforms as Platform[] | undefined) ?? ['amazon', 'ebay', 'walmart', 'aliexpress'] as Platform[];
      const maxResults = 5;

      // Search all configured platforms in parallel
      const searchPromises = targetPlatforms.map(async (platform) => {
        const adapter = getAdapter(platform, creds);
        try {
          const results = await adapter.search({ query, maxResults });
          storeResults(context.db, results);
          return { platform, results, error: null };
        } catch (err) {
          return { platform, results: [] as ProductSearchResult[], error: err instanceof Error ? err.message : String(err) };
        }
      });

      const allResults = await Promise.all(searchPromises);

      const comparisons = allResults.map(r => ({
        platform: r.platform,
        resultCount: r.results.length,
        lowestPrice: r.results.length > 0 ? Math.min(...r.results.map(p => p.price + p.shipping)) : null,
        highestPrice: r.results.length > 0 ? Math.max(...r.results.map(p => p.price + p.shipping)) : null,
        topResults: r.results.slice(0, 3).map(p => ({
          title: p.title,
          price: p.price,
          shipping: p.shipping,
          total: p.price + p.shipping,
          seller: p.seller,
          url: p.url,
          inStock: p.inStock,
        })),
        error: r.error,
      }));

      // Find cheapest source and most expensive target
      const allProducts = allResults.flatMap(r => r.results);
      const cheapest = allProducts.length > 0
        ? allProducts.reduce((min, p) => (p.price + p.shipping) < (min.price + min.shipping) ? p : min)
        : null;
      const mostExpensive = allProducts.length > 0
        ? allProducts.reduce((max, p) => (p.price + p.shipping) > (max.price + max.shipping) ? p : max)
        : null;

      return {
        status: 'ok',
        query,
        comparisons,
        cheapestSource: cheapest ? { platform: cheapest.platform, price: cheapest.price, shipping: cheapest.shipping, total: cheapest.price + cheapest.shipping, title: cheapest.title } : null,
        bestSellPrice: mostExpensive ? { platform: mostExpensive.platform, price: mostExpensive.price, shipping: mostExpensive.shipping, total: mostExpensive.price + mostExpensive.shipping, title: mostExpensive.title } : null,
        potentialSpread: cheapest && mostExpensive ? (mostExpensive.price + mostExpensive.shipping) - (cheapest.price + cheapest.shipping) : 0,
      };
    }

    case 'find_arbitrage': {
      // First check DB for existing opportunities
      const maxResults = typeof input.maxResults === 'number' ? input.maxResults : 10;
      const minMargin = typeof input.minMargin === 'number' ? input.minMargin : 15;
      const opps = context.db.getActiveOpportunities(maxResults);

      // Filter by minimum margin
      const filtered = opps.filter(o => o.marginPct >= minMargin);

      return {
        status: 'ok',
        message: `Found ${filtered.length} arbitrage opportunities with ${minMargin}%+ margin.`,
        opportunities: filtered.map(o => ({
          id: o.id,
          productId: o.productId,
          buyPlatform: o.buyPlatform,
          buyPrice: o.buyPrice,
          buyShipping: o.buyShipping,
          sellPlatform: o.sellPlatform,
          sellPrice: o.sellPrice,
          estimatedFees: o.estimatedFees,
          estimatedProfit: o.estimatedProfit,
          marginPct: o.marginPct,
          score: o.score,
        })),
        count: filtered.length,
      };
    }

    case 'match_products': {
      const query = input.query as string;
      const targetPlatforms = (input.platforms as Platform[] | undefined) ?? ['amazon', 'ebay', 'walmart', 'aliexpress'] as Platform[];

      // Search all platforms for the same product
      const searchPromises = targetPlatforms.map(async (platform) => {
        const adapter = getAdapter(platform, creds);
        try {
          const results = await adapter.search({ query, maxResults: 3 });
          storeResults(context.db, results);
          return { platform, results };
        } catch {
          return { platform, results: [] as ProductSearchResult[] };
        }
      });

      const allResults = await Promise.all(searchPromises);

      const matches = allResults.map(r => ({
        platform: r.platform,
        products: r.results.map(p => ({
          platformId: p.platformId,
          title: p.title,
          price: p.price,
          shipping: p.shipping,
          total: p.price + p.shipping,
          seller: p.seller,
          url: p.url,
          inStock: p.inStock,
        })),
      }));

      return { status: 'ok', query, matches, platformCount: allResults.filter(r => r.results.length > 0).length };
    }

    case 'get_product_details': {
      const platform = input.platform as Platform;
      const productId = input.productId as string;

      // Try DB first
      const dbProduct = context.db.getProduct(productId) ?? context.db.getProduct(`${platform}:${productId}`);
      const latestPrices = dbProduct ? context.db.getLatestPrices(dbProduct.id) : [];

      // Also fetch live from platform
      const adapter = getAdapter(platform, creds);
      try {
        const liveProduct = await adapter.getProduct(productId);
        if (liveProduct) {
          storeResults(context.db, [liveProduct]);
          return {
            status: 'ok',
            product: liveProduct,
            dbProduct: dbProduct ?? null,
            latestPrices,
          };
        }
      } catch (err) {
        logger.warn({ platform, productId, err }, 'Live product fetch failed, using DB');
      }

      if (dbProduct) {
        return { status: 'ok', product: dbProduct, latestPrices };
      }

      return { status: 'error', message: `Product ${productId} not found on ${platform}` };
    }

    case 'check_stock': {
      const platform = input.platform as Platform;
      const productId = input.productId as string;
      const adapter = getAdapter(platform, creds);

      try {
        const stock = await adapter.checkStock(productId);
        return { status: 'ok', platform, productId, ...stock };
      } catch (err) {
        return { status: 'error', message: `Stock check failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'get_price_history': {
      const history = context.db.getPriceHistory(
        input.productId as string,
        input.platform as Platform | undefined,
      );
      return {
        status: 'ok',
        productId: input.productId,
        history,
        count: history.length,
      };
    }

    // -----------------------------------------------------------------------
    // Listings — Real eBay Inventory API
    // -----------------------------------------------------------------------
    case 'create_ebay_listing': {
      const productId = input.productId as string;
      const title = input.title as string;
      const price = input.price as number;
      const description = input.description as string | undefined;
      const category = input.category as string | undefined;

      const result = await createListing('ebay', {
        title,
        description: description ?? '',
        price,
        category: category ?? '0',
        imageUrls: [],
        condition: 'new',
        quantity: 1,
      }, { ebay: creds.ebay });

      if (result.success && result.listingId) {
        // Store listing in DB
        const now = new Date();
        context.db.addListing({
          id: randomUUID().slice(0, 12),
          productId,
          platform: 'ebay',
          platformListingId: result.listingId,
          title,
          price,
          sourcePlatform: 'aliexpress',
          sourcePrice: 0,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
      }

      return { status: result.success ? 'ok' : 'error', ...result };
    }

    case 'create_amazon_listing': {
      const result = await createListing('amazon', {
        title: input.title as string,
        description: (input.description as string) ?? '',
        price: input.price as number,
        category: (input.productType as string) ?? '0',
        imageUrls: input.imageUrl ? [input.imageUrl as string] : [],
        condition: ((input.condition as string) ?? 'new') as 'new' | 'used' | 'refurbished',
        quantity: typeof input.quantity === 'number' ? input.quantity : 1,
      }, { amazon: creds.amazon });
      return { status: result.success ? 'ok' : 'error', ...result };
    }

    case 'update_listing_price': {
      const listingId = input.listingId as string;
      const newPrice = input.newPrice as number;

      // Look up listing to find platform and offer ID
      const listingRows = context.db.query<{
        platform: string;
        platform_listing_id: string;
      }>(
        'SELECT platform, platform_listing_id FROM listings WHERE id = ?',
        [listingId],
      );

      if (listingRows.length === 0) {
        return { status: 'error', message: `Listing ${listingId} not found.` };
      }

      const listing = listingRows[0];
      let platformUpdated = false;

      // If eBay listing with credentials, update price on platform too
      if (listing.platform === 'ebay' && creds.ebay?.refreshToken && listing.platform_listing_id) {
        try {
          const seller = createEbaySellerApi(creds.ebay);
          await seller.updateOfferPrice(listing.platform_listing_id, newPrice);
          platformUpdated = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ listingId, error: msg }, 'Failed to update price on eBay, DB updated only');
        }
      }

      // Update in DB
      context.db.run(
        'UPDATE listings SET price = ?, updated_at = ? WHERE id = ?',
        [newPrice, Date.now(), listingId],
      );

      const platformMsg = platformUpdated
        ? ' Price also updated on eBay.'
        : listing.platform === 'ebay' ? ' Note: Could not update on eBay (check credentials).' : '';
      return { status: 'ok', message: `Listing ${listingId} price updated to $${newPrice.toFixed(2)}.${platformMsg}` };
    }

    case 'optimize_listing': {
      const listingId = input.listingId as string;

      // Get listing from DB
      const listings = context.db.query<{ title: string; price: number }>(
        'SELECT title, price FROM listings WHERE id = ?',
        [listingId],
      );

      if (listings.length === 0) {
        return { status: 'error', message: `Listing ${listingId} not found.` };
      }

      const { title: optimizedTitle, description: optimizedDescription } = await optimizeListing(
        listings[0].title ?? '',
        '',
      );

      return {
        status: 'ok',
        listingId,
        optimized: {
          title: optimizedTitle,
          description: optimizedDescription,
        },
        message: 'Listing optimized. Apply changes with update_listing_price or create a new listing.',
      };
    }

    case 'bulk_list': {
      const ids = input.opportunityIds as string[];
      let created = 0;
      let failed = 0;
      const results: Array<{ opportunityId: string; success: boolean; error?: string }> = [];

      for (const oppId of ids) {
        const opps = context.db.query<{
          product_id: string;
          sell_platform: string;
          sell_price: number;
          buy_platform: string;
          buy_price: number;
        }>(
          'SELECT product_id, sell_platform, sell_price, buy_platform, buy_price FROM opportunities WHERE id = ?',
          [oppId],
        );

        if (opps.length === 0) {
          failed++;
          results.push({ opportunityId: oppId, success: false, error: 'Opportunity not found' });
          continue;
        }

        const opp = opps[0];
        const product = context.db.getProduct(opp.product_id);
        const title = product?.title ?? `Product ${opp.product_id}`;

        try {
          const result = await createListing(opp.sell_platform as Platform, {
            title,
            description: '',
            price: opp.sell_price,
            category: product?.category ?? '0',
            imageUrls: product?.imageUrl ? [product.imageUrl] : [],
            condition: 'new',
            quantity: 1,
          }, { ebay: creds.ebay, amazon: creds.amazon });

          if (result.success) {
            created++;
            const now = new Date();
            context.db.addListing({
              id: randomUUID().slice(0, 12),
              opportunityId: oppId,
              productId: opp.product_id,
              platform: opp.sell_platform as Platform,
              platformListingId: result.listingId,
              title,
              price: opp.sell_price,
              sourcePlatform: opp.buy_platform as Platform,
              sourcePrice: opp.buy_price,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            });
            context.db.updateOpportunityStatus(oppId, 'listed');
          } else {
            failed++;
          }
          results.push({ opportunityId: oppId, success: result.success, error: result.error });
        } catch (err) {
          failed++;
          results.push({ opportunityId: oppId, success: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      return { status: 'ok', created, failed, total: ids.length, results };
    }

    case 'pause_listing': {
      const listingId = input.listingId as string;
      const listingRows = context.db.query<{ platform: string; platform_listing_id: string }>(
        'SELECT platform, platform_listing_id FROM listings WHERE id = ?',
        [listingId],
      );

      if (listingRows.length === 0) {
        return { status: 'error', message: `Listing ${listingId} not found.` };
      }

      // Withdraw from eBay if applicable
      if (listingRows[0].platform === 'ebay' && creds.ebay?.refreshToken && listingRows[0].platform_listing_id) {
        try {
          const seller = createEbaySellerApi(creds.ebay);
          await seller.withdrawOffer(listingRows[0].platform_listing_id);
        } catch (err) {
          logger.warn({ listingId, error: err instanceof Error ? err.message : String(err) }, 'Failed to withdraw offer on eBay');
        }
      }

      context.db.updateListingStatus(listingId, 'paused');
      return { status: 'ok', message: `Listing ${listingId} paused.` };
    }

    case 'resume_listing': {
      const listingId = input.listingId as string;
      const listingRows = context.db.query<{ platform: string; platform_listing_id: string }>(
        'SELECT platform, platform_listing_id FROM listings WHERE id = ?',
        [listingId],
      );

      if (listingRows.length === 0) {
        return { status: 'error', message: `Listing ${listingId} not found.` };
      }

      // Re-publish on eBay if applicable
      if (listingRows[0].platform === 'ebay' && creds.ebay?.refreshToken && listingRows[0].platform_listing_id) {
        try {
          const seller = createEbaySellerApi(creds.ebay);
          await seller.publishOffer(listingRows[0].platform_listing_id);
        } catch (err) {
          logger.warn({ listingId, error: err instanceof Error ? err.message : String(err) }, 'Failed to republish offer on eBay');
        }
      }

      context.db.updateListingStatus(listingId, 'active');
      return { status: 'ok', message: `Listing ${listingId} resumed.` };
    }

    case 'delete_listing': {
      const listingId = input.listingId as string;
      const listingRows = context.db.query<{ platform: string; platform_listing_id: string; sku?: string }>(
        'SELECT platform, platform_listing_id FROM listings WHERE id = ?',
        [listingId],
      );

      if (listingRows.length === 0) {
        return { status: 'error', message: `Listing ${listingId} not found.` };
      }

      // Delete from eBay if applicable
      if (listingRows[0].platform === 'ebay' && creds.ebay?.refreshToken && listingRows[0].platform_listing_id) {
        try {
          const seller = createEbaySellerApi(creds.ebay);
          // Withdraw offer first, then delete inventory item
          await seller.withdrawOffer(listingRows[0].platform_listing_id);
        } catch (err) {
          logger.warn({ listingId, error: err instanceof Error ? err.message : String(err) }, 'Failed to delete listing on eBay');
        }
      }

      context.db.updateListingStatus(listingId, 'expired');
      return { status: 'ok', message: `Listing ${listingId} deleted.` };
    }

    // -----------------------------------------------------------------------
    // Fulfillment — Real API integrations
    // -----------------------------------------------------------------------
    case 'check_orders': {
      const statusFilter = input.status as string | undefined;
      const platformFilter = input.platform as string | undefined;

      let query = 'SELECT * FROM orders WHERE 1=1';
      const params: unknown[] = [];

      if (statusFilter) {
        query += ' AND status = ?';
        params.push(statusFilter);
      }
      if (platformFilter) {
        query += ' AND sell_platform = ?';
        params.push(platformFilter);
      }
      query += ' ORDER BY ordered_at DESC LIMIT 50';

      const orders = context.db.query<Record<string, unknown>>(query, params);
      return {
        status: 'ok',
        orders: orders.map(o => ({
          id: o.id,
          sellPlatform: o.sell_platform,
          sellOrderId: o.sell_order_id,
          sellPrice: o.sell_price,
          buyPlatform: o.buy_platform,
          buyOrderId: o.buy_order_id,
          buyPrice: o.buy_price,
          status: o.status,
          trackingNumber: o.tracking_number,
          profit: o.profit,
          orderedAt: o.ordered_at,
        })),
        count: orders.length,
      };
    }

    case 'auto_purchase': {
      const result = await autoPurchase(
        input.orderId as string,
        context.db,
        { aliexpress: creds.aliexpress },
      );
      return { status: result.success ? 'ok' : 'error', ...result };
    }

    case 'track_shipment': {
      const order = context.db.getOrder(input.orderId as string);
      if (!order) {
        return { status: 'error', message: `Order ${input.orderId} not found.` };
      }

      if (order.trackingNumber) {
        const tracking = await getTracking(
          order.trackingNumber,
          undefined,
          { aliexpress: creds.aliexpress },
        );
        return {
          status: 'ok',
          orderId: order.id,
          trackingNumber: order.trackingNumber,
          orderStatus: order.status,
          tracking,
        };
      }

      return {
        status: 'ok',
        message: `No tracking info available for order ${input.orderId}.`,
        orderId: order.id,
        orderStatus: order.status,
      };
    }

    case 'update_tracking': {
      const orderId = input.orderId as string;
      const trackingNumber = input.trackingNumber as string;
      const carrier = input.carrier as string | undefined;

      context.db.updateOrderStatus(orderId, 'shipped', {
        trackingNumber,
        shippedAt: new Date(),
      });

      // Try to push tracking to selling platform
      const order = context.db.getOrder(orderId);
      if (order?.sellPlatform === 'ebay' && order.sellOrderId) {
        await updateTrackingOnPlatform(
          'ebay',
          order.sellOrderId,
          trackingNumber,
          carrier ?? 'OTHER',
          { ebay: creds.ebay },
        );
      }

      return {
        status: 'ok',
        message: `Tracking updated for order ${orderId}: ${trackingNumber}`,
      };
    }

    case 'handle_return': {
      const orderId = input.orderId as string;
      const order = context.db.getOrder(orderId);

      if (!order) {
        return { status: 'error', message: `Order ${orderId} not found.` };
      }

      // Issue eBay refund if this was an eBay sale
      let refundResult: { refundId?: string; refundStatus?: string } = {};
      if (order.sellPlatform === 'ebay' && order.sellOrderId && creds.ebay?.refreshToken) {
        try {
          const ordersApi = createEbayOrdersApi(creds.ebay);
          refundResult = await ordersApi.issueRefund(order.sellOrderId, {
            reasonForRefund: 'OTHER',
            comment: (input.reason as string) ?? 'Return processed',
          });
        } catch (err) {
          logger.warn({ orderId, error: err instanceof Error ? err.message : String(err) }, 'Failed to issue eBay refund');
        }
      }

      context.db.updateOrderStatus(orderId, 'returned');
      return {
        status: 'ok',
        message: `Return initiated for order ${orderId}.`,
        reason: input.reason ?? 'Not specified',
        refundId: refundResult.refundId,
        refundStatus: refundResult.refundStatus,
      };
    }

    case 'calculate_profit': {
      if (input.orderId) {
        const order = context.db.getOrder(input.orderId as string);
        if (order) {
          // Calculate using real fee calculator if we have both prices
          if (order.sellPrice && order.buyPrice) {
            const calc = calculateProfit(
              order.sellPlatform,
              order.sellPrice,
              order.buyPlatform,
              order.buyPrice,
              0,
              order.shippingCost ?? 0,
            );
            return {
              status: 'ok',
              orderId: order.id,
              sellPrice: order.sellPrice,
              buyPrice: order.buyPrice,
              shippingCost: order.shippingCost,
              platformFees: calc.platformFees,
              netProfit: calc.netProfit,
              marginPct: calc.marginPct,
              roi: calc.roi,
            };
          }
          return {
            status: 'ok',
            orderId: order.id,
            sellPrice: order.sellPrice,
            buyPrice: order.buyPrice,
            profit: order.profit,
            note: 'Partial data — buy price not yet recorded.',
          };
        }
      }

      // Date range profit calculation
      const orders = context.db.query<Record<string, unknown>>(
        "SELECT * FROM orders WHERE status IN ('shipped', 'delivered') ORDER BY ordered_at DESC LIMIT 100",
      );

      let totalRevenue = 0;
      let totalCosts = 0;
      let totalProfit = 0;
      for (const o of orders) {
        totalRevenue += (o.sell_price as number) ?? 0;
        totalCosts += ((o.buy_price as number) ?? 0) + ((o.shipping_cost as number) ?? 0) + ((o.platform_fees as number) ?? 0);
        totalProfit += (o.profit as number) ?? 0;
      }

      return {
        status: 'ok',
        orderCount: orders.length,
        totalRevenue,
        totalCosts,
        totalProfit,
        avgMargin: totalRevenue > 0 ? (totalProfit / totalRevenue * 100) : 0,
      };
    }

    // -----------------------------------------------------------------------
    // Analytics — DB-powered
    // -----------------------------------------------------------------------
    case 'daily_report': {
      const date = (input.date as string) ?? new Date().toISOString().split('T')[0];
      const dayStart = new Date(date + 'T00:00:00Z').getTime();
      const dayEnd = new Date(date + 'T23:59:59Z').getTime();

      const newOpps = context.db.query<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM opportunities WHERE found_at >= ? AND found_at <= ?',
        [dayStart, dayEnd],
      );
      const newListings = context.db.query<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM listings WHERE created_at >= ? AND created_at <= ?',
        [dayStart, dayEnd],
      );
      const ordersToday = context.db.query<Record<string, unknown>>(
        'SELECT sell_price, profit FROM orders WHERE ordered_at >= ? AND ordered_at <= ?',
        [dayStart, dayEnd],
      );

      let revenue = 0;
      let profit = 0;
      for (const o of ordersToday) {
        revenue += (o.sell_price as number) ?? 0;
        profit += (o.profit as number) ?? 0;
      }

      return {
        status: 'ok',
        date,
        newOpportunities: newOpps[0]?.cnt ?? 0,
        listingsCreated: newListings[0]?.cnt ?? 0,
        ordersFulfilled: ordersToday.length,
        revenue,
        profit,
        activeListings: context.db.getActiveListings().length,
        activeOpportunities: context.db.getActiveOpportunities(999).length,
      };
    }

    case 'profit_dashboard': {
      const period = (input.period as string) ?? '7d';
      let daysBack = 7;
      if (period === '30d') daysBack = 30;
      else if (period === 'mtd') daysBack = new Date().getDate();
      else if (period === 'ytd') daysBack = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000);

      const since = Date.now() - daysBack * 86400000;

      const orders = context.db.query<Record<string, unknown>>(
        "SELECT sell_price, buy_price, shipping_cost, platform_fees, profit FROM orders WHERE ordered_at >= ? AND status IN ('shipped', 'delivered', 'purchased')",
        [since],
      );

      let totalRevenue = 0;
      let totalCosts = 0;
      let totalFees = 0;
      let netProfit = 0;
      for (const o of orders) {
        totalRevenue += (o.sell_price as number) ?? 0;
        totalCosts += ((o.buy_price as number) ?? 0) + ((o.shipping_cost as number) ?? 0);
        totalFees += (o.platform_fees as number) ?? 0;
        netProfit += (o.profit as number) ?? 0;
      }

      return {
        status: 'ok',
        period,
        daysBack,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCosts: Math.round(totalCosts * 100) / 100,
        totalFees: Math.round(totalFees * 100) / 100,
        netProfit: Math.round(netProfit * 100) / 100,
        marginPct: totalRevenue > 0 ? Math.round((netProfit / totalRevenue) * 10000) / 100 : 0,
        orderCount: orders.length,
      };
    }

    case 'top_opportunities': {
      const limit = typeof input.limit === 'number' ? input.limit : 10;
      const minMargin = typeof input.minMargin === 'number' ? input.minMargin : 10;
      const opps = context.db.getActiveOpportunities(limit * 2); // Fetch extra, then filter
      const filtered = opps.filter(o => o.marginPct >= minMargin).slice(0, limit);
      return {
        status: 'ok',
        opportunities: filtered,
        count: filtered.length,
      };
    }

    case 'category_analysis': {
      const catFilter = input.category as string | undefined;

      let query = `SELECT
        COALESCE(p.category, 'Uncategorized') as category,
        COUNT(DISTINCT o.id) as opportunity_count,
        AVG(o.margin_pct) as avg_margin,
        MIN(o.buy_price) as min_buy_price,
        MAX(o.sell_price) as max_sell_price,
        AVG(o.estimated_profit) as avg_profit
      FROM opportunities o
      LEFT JOIN products p ON o.product_id = p.id
      WHERE o.status = 'active'`;

      const params: unknown[] = [];
      if (catFilter) {
        query += ' AND p.category LIKE ?';
        params.push(`%${catFilter}%`);
      }
      query += ' GROUP BY p.category ORDER BY avg_margin DESC LIMIT 20';

      const analysis = context.db.query<Record<string, unknown>>(query, params);

      return {
        status: 'ok',
        category: catFilter ?? 'all',
        analysis: analysis.map(a => ({
          category: a.category,
          opportunityCount: a.opportunity_count,
          avgMargin: Math.round((a.avg_margin as number) * 100) / 100,
          minBuyPrice: a.min_buy_price,
          maxSellPrice: a.max_sell_price,
          avgProfit: Math.round((a.avg_profit as number) * 100) / 100,
        })),
      };
    }

    case 'competitor_watch': {
      const productId = input.productId as string | undefined;
      const platform = input.platform as Platform | undefined;

      if (productId) {
        // Get all price snapshots for this product
        const prices = context.db.getLatestPrices(productId);
        return {
          status: 'ok',
          productId,
          competitors: prices.map(p => ({
            platform: p.platform,
            price: p.price,
            shipping: p.shipping,
            total: p.price + p.shipping,
            seller: p.seller,
            inStock: p.inStock,
            lastChecked: p.fetchedAt,
          })),
        };
      }

      // Get recent price changes for listings we're tracking
      const listings = context.db.getActiveListings();
      const competitorData = listings.slice(0, 10).map(l => {
        const prices = context.db.getLatestPrices(l.productId);
        return {
          listingId: l.id,
          productId: l.productId,
          ourPrice: l.price,
          competitorPrices: prices
            .filter(p => p.platform !== l.platform)
            .map(p => ({ platform: p.platform, price: p.price + p.shipping, seller: p.seller })),
        };
      });

      return { status: 'ok', competitors: competitorData, count: competitorData.length };
    }

    case 'fee_calculator': {
      const platform = input.platform as Platform;
      const price = input.price as number;
      const category = input.category as string | undefined;

      const fees = calculateFees(platform, price, category);

      return {
        status: 'ok',
        platform,
        salePrice: price,
        ...fees,
      };
    }

    // -----------------------------------------------------------------------
    // Extended platform tools — Real API calls
    // -----------------------------------------------------------------------
    case 'get_shipping_cost': {
      if (!creds.aliexpress) {
        return { status: 'error', message: 'AliExpress credentials not configured.' };
      }
      const shippingApi = createAliExpressShippingApi({
        appKey: creds.aliexpress.appKey,
        appSecret: creds.aliexpress.appSecret,
        accessToken: creds.aliexpress.accessToken,
      });
      const methods = await shippingApi.queryShippingCost({
        productId: input.productId as string,
        country: (input.country as string) ?? 'US',
        productNum: typeof input.quantity === 'number' ? input.quantity : 1,
      });
      return { status: 'ok', shippingMethods: methods, count: methods.length };
    }

    case 'get_hot_products': {
      if (!creds.aliexpress) {
        return { status: 'error', message: 'AliExpress credentials not configured.' };
      }
      const extApi = createAliExpressExtendedApi({
        appKey: creds.aliexpress.appKey,
        appSecret: creds.aliexpress.appSecret,
      });
      const products = await extApi.queryHotProducts({
        keywords: input.keywords as string | undefined,
        categoryId: input.categoryId as string | undefined,
        minSalePrice: input.minPrice as number | undefined,
        maxSalePrice: input.maxPrice as number | undefined,
        sort: input.sort as 'SALE_PRICE_ASC' | 'SALE_PRICE_DESC' | 'LAST_VOLUME_ASC' | 'LAST_VOLUME_DESC' | undefined,
        pageSize: typeof input.maxResults === 'number' ? input.maxResults : 20,
      });
      return { status: 'ok', products, count: products.length };
    }

    case 'get_aliexpress_categories': {
      if (!creds.aliexpress) {
        return { status: 'error', message: 'AliExpress credentials not configured.' };
      }
      const extApi = createAliExpressExtendedApi({
        appKey: creds.aliexpress.appKey,
        appSecret: creds.aliexpress.appSecret,
      });
      const categories = await extApi.getCategories();
      return { status: 'ok', categories, count: categories.length };
    }

    case 'get_product_variations': {
      if (!creds.amazon) {
        return { status: 'error', message: 'Amazon credentials not configured.' };
      }
      const amazonExt = createAmazonExtendedApi({
        accessKeyId: creds.amazon.accessKeyId,
        secretAccessKey: creds.amazon.secretAccessKey,
        partnerTag: creds.amazon.partnerTag,
        host: creds.amazon.marketplace ? undefined : undefined,
        region: undefined,
      });
      const variations = await amazonExt.getVariations(
        input.asin as string,
        input.marketplace as string | undefined,
      );
      return { status: 'ok', ...variations };
    }

    case 'browse_amazon_categories': {
      if (!creds.amazon) {
        return { status: 'error', message: 'Amazon credentials not configured.' };
      }
      const amazonExt = createAmazonExtendedApi({
        accessKeyId: creds.amazon.accessKeyId,
        secretAccessKey: creds.amazon.secretAccessKey,
        partnerTag: creds.amazon.partnerTag,
      });
      const nodes = await amazonExt.getBrowseNodes(
        input.nodeIds as string[],
        input.marketplace as string | undefined,
      );
      return { status: 'ok', nodes, count: nodes.length };
    }

    case 'ebay_get_policies': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const accountApi = createEbayAccountApi(creds.ebay);
      const policyType = (input.policyType as string) ?? 'all';
      const marketplaceId = (input.marketplaceId as string) ?? 'EBAY_US';

      if (policyType === 'all') {
        const all = await accountApi.getAllPolicies(marketplaceId);
        return { status: 'ok', ...all };
      } else if (policyType === 'fulfillment') {
        const policies = await accountApi.getFulfillmentPolicies(marketplaceId);
        return { status: 'ok', fulfillment: policies };
      } else if (policyType === 'payment') {
        const policies = await accountApi.getPaymentPolicies(marketplaceId);
        return { status: 'ok', payment: policies };
      } else {
        const policies = await accountApi.getReturnPolicies(marketplaceId);
        return { status: 'ok', return: policies };
      }
    }

    case 'ebay_create_policy': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const accountApi = createEbayAccountApi(creds.ebay);
      const policyType = input.policyType as string;
      const name = input.name as string;

      if (policyType === 'fulfillment') {
        const policyId = await accountApi.createFulfillmentPolicy({
          name,
          marketplaceId: 'EBAY_US',
          handlingTimeDays: typeof input.handlingTimeDays === 'number' ? input.handlingTimeDays : 1,
          shippingServiceCode: (input.shippingServiceCode as string) ?? 'ShippingMethodStandard',
          freeShipping: input.freeShipping as boolean | undefined,
        });
        return { status: 'ok', policyType, policyId, name };
      } else if (policyType === 'payment') {
        const policyId = await accountApi.createPaymentPolicy({ name, marketplaceId: 'EBAY_US' });
        return { status: 'ok', policyType, policyId, name };
      } else {
        const policyId = await accountApi.createReturnPolicy({
          name,
          marketplaceId: 'EBAY_US',
          returnsAccepted: input.returnsAccepted !== false,
          returnDays: typeof input.returnDays === 'number' ? input.returnDays : 30,
          returnShippingCostPayer: 'BUYER',
        });
        return { status: 'ok', policyType, policyId, name };
      }
    }

    case 'ebay_category_suggest': {
      if (!creds.ebay) {
        return { status: 'error', message: 'eBay credentials not configured.' };
      }
      const taxonomyApi = createEbayTaxonomyApi(creds.ebay);
      const suggestions = await taxonomyApi.getCategorySuggestions(input.query as string);
      return { status: 'ok', suggestions, count: suggestions.length };
    }

    case 'ebay_item_aspects': {
      if (!creds.ebay) {
        return { status: 'error', message: 'eBay credentials not configured.' };
      }
      const taxonomyApi = createEbayTaxonomyApi(creds.ebay);
      const aspects = await taxonomyApi.getItemAspectsForCategory(input.categoryId as string);
      return {
        status: 'ok',
        categoryId: input.categoryId,
        aspects: aspects.map(a => ({
          name: a.localizedAspectName,
          required: a.aspectConstraint.aspectRequired ?? false,
          mode: a.aspectConstraint.aspectMode ?? 'FREE_TEXT',
          values: a.aspectValues?.slice(0, 20).map(v => v.localizedValue),
        })),
        count: aspects.length,
      };
    }

    case 'ebay_get_inventory': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const seller = createEbaySellerApi(creds.ebay);
      const result = await seller.getInventoryItems({
        limit: typeof input.limit === 'number' ? input.limit : 25,
        offset: typeof input.offset === 'number' ? input.offset : 0,
      });
      return { status: 'ok', ...result };
    }

    case 'ebay_bulk_update': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const seller = createEbaySellerApi(creds.ebay);
      const updates = input.updates as Array<{ sku: string; offerId: string; price?: number; quantity?: number }>;
      const result = await seller.bulkUpdatePriceQuantity(updates);
      return { status: 'ok', ...result };
    }

    case 'ebay_issue_refund': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const ordersApi = createEbayOrdersApi(creds.ebay);
      const refundReq: Record<string, unknown> = {
        reasonForRefund: input.reason as string,
        comment: input.comment as string | undefined,
      };
      if (typeof input.amount === 'number') {
        refundReq.orderLevelRefundAmount = { value: (input.amount as number).toFixed(2), currency: 'USD' };
      }
      const refund = await ordersApi.issueRefund(input.orderId as string, refundReq as any);
      return { status: 'ok', ...refund };
    }

    case 'walmart_upc_lookup': {
      if (!creds.walmart) {
        return { status: 'error', message: 'Walmart credentials not configured.' };
      }
      const walmartExt = createWalmartExtendedApi(creds.walmart);
      const item = await walmartExt.lookupByUpc(input.upc as string);
      if (!item) {
        return { status: 'error', message: `No Walmart product found for UPC ${input.upc}` };
      }
      return { status: 'ok', product: item };
    }

    case 'walmart_trending': {
      if (!creds.walmart) {
        return { status: 'error', message: 'Walmart credentials not configured.' };
      }
      const walmartExt = createWalmartExtendedApi(creds.walmart);
      const items = await walmartExt.getTrending();
      return { status: 'ok', products: items, count: items.length };
    }

    case 'walmart_taxonomy': {
      if (!creds.walmart) {
        return { status: 'error', message: 'Walmart credentials not configured.' };
      }
      const walmartExt = createWalmartExtendedApi(creds.walmart);
      const categories = await walmartExt.getTaxonomy();
      return { status: 'ok', categories, count: categories.length };
    }

    case 'get_ds_order_status': {
      if (!creds.aliexpress) {
        return { status: 'error', message: 'AliExpress credentials not configured.' };
      }
      const dsOrders = createAliExpressOrdersApi({
        appKey: creds.aliexpress.appKey,
        appSecret: creds.aliexpress.appSecret,
        accessToken: creds.aliexpress.accessToken,
      });
      const status = await dsOrders.getDsOrderStatus(input.orderId as string);
      if (!status) {
        return { status: 'error', message: `Order ${input.orderId} not found or access denied.` };
      }
      return { status: 'ok', ...status };
    }

    // -----------------------------------------------------------------------
    // Amazon SP-API tools
    // -----------------------------------------------------------------------
    case 'amazon_sp_search_catalog': {
      if (!creds.amazon?.spRefreshToken) {
        return { status: 'error', message: 'Amazon SP-API credentials not configured. Use setup_amazon_sp_credentials first.' };
      }
      const spApi = createAmazonSpApi({
        clientId: creds.amazon.spClientId!,
        clientSecret: creds.amazon.spClientSecret!,
        refreshToken: creds.amazon.spRefreshToken,
      });
      const keywords = input.keywords ? (input.keywords as string).split(',').map(s => s.trim()) : undefined;
      const identifiers = input.identifiers ? (input.identifiers as string).split(',').map(s => s.trim()) : undefined;
      const result = await spApi.searchCatalog({
        keywords,
        identifiers,
        identifiersType: input.identifiersType as 'ASIN' | 'UPC' | 'EAN' | 'ISBN' | undefined,
        pageSize: typeof input.maxResults === 'number' ? input.maxResults : 20,
      });
      return { status: 'ok', items: result.items, count: result.items.length, nextPageToken: result.nextPageToken };
    }

    case 'amazon_sp_get_pricing': {
      if (!creds.amazon?.spRefreshToken) {
        return { status: 'error', message: 'Amazon SP-API credentials not configured.' };
      }
      const spApi = createAmazonSpApi({
        clientId: creds.amazon.spClientId!,
        clientSecret: creds.amazon.spClientSecret!,
        refreshToken: creds.amazon.spRefreshToken,
      });
      const asins = (input.asins as string).split(',').map(s => s.trim());
      const pricing = await spApi.getCompetitivePricing(asins);
      return { status: 'ok', pricing, count: pricing.length };
    }

    case 'amazon_sp_estimate_fees': {
      if (!creds.amazon?.spRefreshToken) {
        return { status: 'error', message: 'Amazon SP-API credentials not configured.' };
      }
      const spApi = createAmazonSpApi({
        clientId: creds.amazon.spClientId!,
        clientSecret: creds.amazon.spClientSecret!,
        refreshToken: creds.amazon.spRefreshToken,
      });
      const fees = await spApi.getMyFeesEstimate([{
        asin: input.asin as string,
        price: input.price as number,
        shipping: typeof input.shipping === 'number' ? input.shipping : 0,
        isAmazonFulfilled: input.fba as boolean | undefined,
      }]);
      return { status: 'ok', fees: fees[0] ?? null };
    }

    case 'amazon_sp_create_listing': {
      if (!creds.amazon?.spRefreshToken) {
        return { status: 'error', message: 'Amazon SP-API credentials not configured.' };
      }
      const spApi = createAmazonSpApi({
        clientId: creds.amazon.spClientId!,
        clientSecret: creds.amazon.spClientSecret!,
        refreshToken: creds.amazon.spRefreshToken,
      });
      const attributes: Record<string, unknown> = {};
      if (input.title) attributes.item_name = [{ value: input.title, language_tag: 'en_US' }];
      if (input.price) attributes.purchasable_offer = [{ our_price: [{ schedule: [{ value_with_tax: input.price }] }], currency: 'USD' }];
      if (input.condition) attributes.condition_type = [{ value: input.condition }];
      if (input.quantity) attributes.fulfillment_availability = [{ fulfillment_channel_code: 'DEFAULT', quantity: input.quantity }];

      const result = await spApi.putListingsItem({
        sku: input.sku as string,
        productType: input.productType as string,
        attributes,
      });
      return { status: 'ok', spStatus: result.status, submissionId: result.submissionId, issues: result.issues };
    }

    case 'amazon_sp_get_orders': {
      if (!creds.amazon?.spRefreshToken) {
        return { status: 'error', message: 'Amazon SP-API credentials not configured.' };
      }
      const spApi = createAmazonSpApi({
        clientId: creds.amazon.spClientId!,
        clientSecret: creds.amazon.spClientSecret!,
        refreshToken: creds.amazon.spRefreshToken,
      });
      const orderStatuses = input.orderStatuses ? (input.orderStatuses as string).split(',').map(s => s.trim()) : undefined;
      const result = await spApi.getOrders({
        createdAfter: input.createdAfter as string | undefined,
        orderStatuses,
        maxResults: typeof input.maxResults === 'number' ? input.maxResults : 50,
      });
      return { status: 'ok', orders: result.orders, count: result.orders.length, nextToken: result.nextToken };
    }

    case 'amazon_sp_get_fba_inventory': {
      if (!creds.amazon?.spRefreshToken) {
        return { status: 'error', message: 'Amazon SP-API credentials not configured.' };
      }
      const spApi = createAmazonSpApi({
        clientId: creds.amazon.spClientId!,
        clientSecret: creds.amazon.spClientSecret!,
        refreshToken: creds.amazon.spRefreshToken,
      });
      const sellerSkus = input.sellerSkus ? (input.sellerSkus as string).split(',').map(s => s.trim()) : undefined;
      const result = await spApi.getInventorySummaries({ sellerSkus });
      return { status: 'ok', summaries: result.summaries, count: result.summaries.length };
    }

    // -----------------------------------------------------------------------
    // eBay Finances / Analytics / Marketing
    // -----------------------------------------------------------------------
    case 'ebay_get_transactions': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const finApi = createEbayFinancesApi(creds.ebay);
      const result = await finApi.getTransactions({
        filter: input.filter as string | undefined,
        sort: input.sort as string | undefined,
        limit: typeof input.limit === 'number' ? input.limit : 50,
      });
      return { status: 'ok', ...result };
    }

    case 'ebay_get_payouts': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const finApi = createEbayFinancesApi(creds.ebay);
      const result = await finApi.getPayouts({
        filter: input.filter as string | undefined,
        limit: typeof input.limit === 'number' ? input.limit : 50,
      });
      return { status: 'ok', ...result };
    }

    case 'ebay_funds_summary': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const finApi = createEbayFinancesApi(creds.ebay);
      const summary = await finApi.getFundsSummary();
      if (!summary) {
        return { status: 'error', message: 'Could not retrieve funds summary.' };
      }
      return { status: 'ok', ...summary };
    }

    case 'ebay_traffic_report': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const analyticsApi = createEbayAnalyticsApi(creds.ebay);
      const metricsStr = (input.metrics as string) ?? 'CLICK_THROUGH_RATE,LISTING_VIEWS_TOTAL,SALES_CONVERSION_RATE,TRANSACTION';
      const metrics = metricsStr.split(',').map(s => s.trim());
      const report = await analyticsApi.getTrafficReport({
        dimension: (input.dimension as 'DAY' | 'LISTING') ?? 'DAY',
        filter: (input.dateRange as string) ?? '',
        metrics,
      });
      return { status: 'ok', report };
    }

    case 'ebay_seller_metrics': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const analyticsApi = createEbayAnalyticsApi(creds.ebay);
      const metric = await analyticsApi.getCustomerServiceMetric({
        metricType: input.metricType as 'ITEM_NOT_AS_DESCRIBED' | 'ITEM_NOT_RECEIVED',
        evaluationType: (input.evaluationType as 'CURRENT' | 'PROJECTED') ?? 'CURRENT',
      });
      return { status: 'ok', metric };
    }

    case 'ebay_create_campaign': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const marketingApi = createEbayMarketingApi(creds.ebay);
      const campaignId = await marketingApi.createCampaign({
        campaignName: input.campaignName as string,
        bidPercentage: (input.bidPercentage as string) ?? '5.0',
        fundingModel: (input.fundingModel as 'COST_PER_SALE' | 'COST_PER_CLICK') ?? 'COST_PER_SALE',
      });
      return { status: 'ok', campaignId, campaignName: input.campaignName };
    }

    case 'ebay_get_campaigns': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const marketingApi = createEbayMarketingApi(creds.ebay);
      const result = await marketingApi.getCampaigns({
        campaignStatus: input.campaignStatus as string | undefined,
      });
      return { status: 'ok', ...result };
    }

    case 'ebay_promote_listings': {
      if (!creds.ebay?.refreshToken) {
        return { status: 'error', message: 'eBay credentials with refresh token required.' };
      }
      const marketingApi = createEbayMarketingApi(creds.ebay);
      const listingIds = (input.listingIds as string).split(',').map(s => s.trim());
      const result = await marketingApi.bulkCreateAds(
        input.campaignId as string,
        listingIds,
        (input.bidPercentage as string) ?? '5.0',
      );
      return { status: 'ok', ...result };
    }

    // -----------------------------------------------------------------------
    // Keepa — Amazon price intelligence
    // -----------------------------------------------------------------------
    case 'keepa_price_history': {
      const keepaCreds = creds.keepa ?? (creds.amazon as Record<string, unknown> | undefined);
      const keepaKey = (keepaCreds as Record<string, unknown> | undefined)?.keepaApiKey as string | undefined;
      if (!keepaKey) {
        return { status: 'error', message: 'Keepa API key not configured. Use setup_keepa_credentials first.' };
      }
      const keepa = createKeepaApi({ apiKey: keepaKey });
      const asins = (input.asin as string).split(',').map(s => s.trim());
      const products = await keepa.getProduct({
        asin: asins,
        history: input.history !== false,
        stats: 180,
      });
      return {
        status: 'ok',
        products: products.map(p => ({
          asin: p.asin,
          title: p.title,
          brand: p.brand,
          category: p.productGroup,
          stats: p.stats ? {
            currentPrice: p.stats.current ? keepa.keepaPriceToDollar(p.stats.current[0] ?? -1) : null,
            avg30: p.stats.avg30 ? keepa.keepaPriceToDollar(p.stats.avg30[0] ?? -1) : null,
            avg90: p.stats.avg90 ? keepa.keepaPriceToDollar(p.stats.avg90[0] ?? -1) : null,
            avg180: p.stats.avg180 ? keepa.keepaPriceToDollar(p.stats.avg180[0] ?? -1) : null,
            allTimeMin: p.stats.minPriceEver ? keepa.keepaPriceToDollar(p.stats.minPriceEver[0] ?? -1) : null,
            allTimeMax: p.stats.maxPriceEver ? keepa.keepaPriceToDollar(p.stats.maxPriceEver[0] ?? -1) : null,
            outOfStock30: p.stats.outOfStockPercentage30?.[0],
            outOfStock90: p.stats.outOfStockPercentage90?.[0],
          } : null,
          salesRank: p.salesRankReference,
          lastUpdate: p.lastUpdate ? keepa.keepaTimeToDate(p.lastUpdate).toISOString() : null,
        })),
        count: products.length,
      };
    }

    case 'keepa_deals': {
      const keepaCreds2 = creds.keepa ?? (creds.amazon as Record<string, unknown> | undefined);
      const keepaKey2 = (keepaCreds2 as Record<string, unknown> | undefined)?.keepaApiKey as string | undefined;
      if (!keepaKey2) {
        return { status: 'error', message: 'Keepa API key not configured.' };
      }
      const keepa = createKeepaApi({ apiKey: keepaKey2 });
      const minPct = typeof input.minPercentOff === 'number' ? input.minPercentOff : 20;
      const maxPct = typeof input.maxPercentOff === 'number' ? input.maxPercentOff : 90;
      const categoryIds = input.categoryIds ? (input.categoryIds as string).split(',').map(Number) : undefined;
      const deals = await keepa.getDeals({
        deltaPercentRange: [minPct, maxPct],
        categoryIds,
      });
      return { status: 'ok', deals, count: deals.length };
    }

    case 'keepa_bestsellers': {
      const keepaCreds3 = creds.keepa ?? (creds.amazon as Record<string, unknown> | undefined);
      const keepaKey3 = (keepaCreds3 as Record<string, unknown> | undefined)?.keepaApiKey as string | undefined;
      if (!keepaKey3) {
        return { status: 'error', message: 'Keepa API key not configured.' };
      }
      const keepa = createKeepaApi({ apiKey: keepaKey3 });
      const asins = await keepa.getBestsellers({ categoryId: input.categoryId as number });
      return { status: 'ok', asins, count: asins.length };
    }

    case 'keepa_track_product': {
      const keepaCreds4 = creds.keepa ?? (creds.amazon as Record<string, unknown> | undefined);
      const keepaKey4 = (keepaCreds4 as Record<string, unknown> | undefined)?.keepaApiKey as string | undefined;
      if (!keepaKey4) {
        return { status: 'error', message: 'Keepa API key not configured.' };
      }
      const keepa = createKeepaApi({ apiKey: keepaKey4 });
      const priceInCents = Math.round((input.targetPrice as number) * 100);
      const success = await keepa.addTracking({
        asin: input.asin as string,
        thresholdValue: priceInCents,
      });
      return {
        status: success ? 'ok' : 'error',
        message: success
          ? `Tracking set for ${input.asin} — alert when price drops below $${(input.targetPrice as number).toFixed(2)}`
          : 'Failed to set up tracking.',
      };
    }

    // -----------------------------------------------------------------------
    // EasyPost — Shipping labels + tracking
    // -----------------------------------------------------------------------
    case 'get_shipping_rates': {
      const epCreds = creds.easypost ?? (creds.ebay as Record<string, unknown> | undefined);
      const epKey = (epCreds as Record<string, unknown> | undefined)?.easypostApiKey as string | undefined;
      if (!epKey) {
        return { status: 'error', message: 'EasyPost API key not configured. Use setup_easypost_credentials first.' };
      }
      const ep = createEasyPostApi({ apiKey: epKey });
      const shipment = await ep.createShipment({
        fromAddress: {
          street1: '123 Main St', // placeholder, user can provide
          city: input.fromCity as string ?? '',
          state: input.fromState as string ?? '',
          zip: input.fromZip as string,
          country: 'US',
        },
        toAddress: {
          street1: '456 Oak Ave', // placeholder
          city: input.toCity as string ?? '',
          state: input.toState as string ?? '',
          zip: input.toZip as string,
          country: (input.toCountry as string) ?? 'US',
        },
        parcel: {
          weight: input.weightOz as number,
          length: typeof input.lengthIn === 'number' ? input.lengthIn : 10,
          width: typeof input.widthIn === 'number' ? input.widthIn : 7,
          height: typeof input.heightIn === 'number' ? input.heightIn : 5,
        },
      });
      const cheapest = ep.getCheapestRate(shipment.rates);
      return {
        status: 'ok',
        shipmentId: shipment.id,
        rates: shipment.rates.map(r => ({
          rateId: r.id,
          carrier: r.carrier,
          service: r.service,
          rate: r.rate,
          currency: r.currency,
          deliveryDays: r.deliveryDays ?? r.estDeliveryDays,
        })),
        cheapest: cheapest ? {
          carrier: cheapest.carrier,
          service: cheapest.service,
          rate: cheapest.rate,
          rateId: cheapest.id,
        } : null,
        rateCount: shipment.rates.length,
      };
    }

    case 'buy_shipping_label': {
      const epCreds2 = creds.easypost ?? (creds.ebay as Record<string, unknown> | undefined);
      const epKey2 = (epCreds2 as Record<string, unknown> | undefined)?.easypostApiKey as string | undefined;
      if (!epKey2) {
        return { status: 'error', message: 'EasyPost API key not configured.' };
      }
      const ep = createEasyPostApi({ apiKey: epKey2 });
      const purchased = await ep.buyShipment(input.shipmentId as string, input.rateId as string);
      return {
        status: 'ok',
        trackingCode: purchased.trackingCode,
        labelUrl: purchased.postageLabel?.labelUrl,
        carrier: purchased.selectedRate?.carrier,
        service: purchased.selectedRate?.service,
        rate: purchased.selectedRate?.rate,
      };
    }

    case 'track_package': {
      const epCreds3 = creds.easypost ?? (creds.ebay as Record<string, unknown> | undefined);
      const epKey3 = (epCreds3 as Record<string, unknown> | undefined)?.easypostApiKey as string | undefined;
      if (!epKey3) {
        return { status: 'error', message: 'EasyPost API key not configured.' };
      }
      const ep = createEasyPostApi({ apiKey: epKey3 });
      const tracker = await ep.createTracker(input.trackingCode as string, input.carrier as string | undefined);
      return {
        status: 'ok',
        trackingCode: tracker.trackingCode,
        carrier: tracker.carrier,
        currentStatus: tracker.status,
        statusDetail: tracker.statusDetail,
        estDeliveryDate: tracker.estDeliveryDate,
        signedBy: tracker.signedBy,
        publicUrl: tracker.publicUrl,
        events: tracker.trackingDetails.slice(0, 10).map(d => ({
          status: d.status,
          message: d.message,
          datetime: d.datetime,
          location: d.trackingLocation ? `${d.trackingLocation.city ?? ''}, ${d.trackingLocation.state ?? ''} ${d.trackingLocation.zip ?? ''}`.trim() : null,
        })),
      };
    }

    case 'verify_address': {
      const epCreds4 = creds.easypost ?? (creds.ebay as Record<string, unknown> | undefined);
      const epKey4 = (epCreds4 as Record<string, unknown> | undefined)?.easypostApiKey as string | undefined;
      if (!epKey4) {
        return { status: 'error', message: 'EasyPost API key not configured.' };
      }
      const ep = createEasyPostApi({ apiKey: epKey4 });
      const verified = await ep.verifyAddress({
        street1: input.street1 as string,
        street2: input.street2 as string | undefined,
        city: input.city as string,
        state: input.state as string,
        zip: input.zip as string,
        country: (input.country as string) ?? 'US',
      });
      return {
        status: 'ok',
        verified: verified.verifications?.delivery?.success ?? false,
        address: {
          street1: verified.street1,
          street2: verified.street2,
          city: verified.city,
          state: verified.state,
          zip: verified.zip,
          country: verified.country,
        },
        errors: verified.verifications?.delivery?.errors,
      };
    }

    // -----------------------------------------------------------------------
    // Credential setup for new services
    // -----------------------------------------------------------------------
    case 'setup_amazon_sp_credentials': {
      // Merge SP-API fields into existing Amazon credentials
      const existing = creds.amazon ?? {} as AmazonCredentials;
      const merged = {
        ...existing,
        spClientId: input.spClientId as string,
        spClientSecret: input.spClientSecret as string,
        spRefreshToken: input.spRefreshToken as string,
      };
      if (context.credentials.setCredentials) {
        context.credentials.setCredentials(context.userId, 'amazon', merged);
      }
      return { status: 'ok', message: 'Amazon SP-API credentials saved. You can now use Amazon seller operations.' };
    }

    case 'setup_keepa_credentials': {
      // Store Keepa key as part of a dedicated credential
      if (context.credentials.setCredentials) {
        // Store under a special key — for now we keep it simple
        const existing = creds.amazon ?? {} as AmazonCredentials;
        const merged = { ...existing, keepaApiKey: input.apiKey as string };
        context.credentials.setCredentials(context.userId, 'amazon', merged);
      }
      return { status: 'ok', message: 'Keepa API key saved. You can now access Amazon price history.' };
    }

    case 'setup_easypost_credentials': {
      if (context.credentials.setCredentials) {
        const existing = creds.ebay ?? {} as EbayCredentials;
        const merged = { ...existing, easypostApiKey: input.apiKey as string };
        context.credentials.setCredentials(context.userId, 'ebay', merged);
      }
      return { status: 'ok', message: 'EasyPost API key saved. You can now compare shipping rates and create labels.' };
    }

    case 'setup_walmart_seller_credentials': {
      if (context.credentials.setCredentials) {
        const existing = creds.walmart ?? {} as WalmartCredentials;
        const merged = {
          ...existing,
          sellerClientId: input.clientId as string,
          sellerClientSecret: input.clientSecret as string,
        };
        context.credentials.setCredentials(context.userId, 'walmart', merged);
      }
      return { status: 'ok', message: 'Walmart Marketplace seller credentials saved. You can now manage Walmart listings and orders.' };
    }

    // -----------------------------------------------------------------------
    // Walmart Marketplace seller operations
    // -----------------------------------------------------------------------
    case 'walmart_get_seller_items': {
      const wCreds = creds.walmart as Record<string, unknown> | undefined;
      const sellerId = (wCreds?.sellerClientId as string | undefined);
      const sellerSecret = (wCreds?.sellerClientSecret as string | undefined);
      if (!sellerId || !sellerSecret) {
        return { status: 'error', message: 'Walmart Marketplace seller credentials not configured. Use setup_walmart_seller_credentials first.' };
      }
      const sellerApi = createWalmartSellerApi({ clientId: sellerId, clientSecret: sellerSecret });
      const result = await sellerApi.getAllItems({
        limit: typeof input.limit === 'number' ? input.limit : 20,
        offset: typeof input.offset === 'number' ? input.offset : 0,
      });
      return { status: 'ok', ...result };
    }

    case 'walmart_update_price': {
      const wCreds2 = creds.walmart as Record<string, unknown> | undefined;
      const sellerId2 = (wCreds2?.sellerClientId as string | undefined);
      const sellerSecret2 = (wCreds2?.sellerClientSecret as string | undefined);
      if (!sellerId2 || !sellerSecret2) {
        return { status: 'error', message: 'Walmart Marketplace seller credentials not configured.' };
      }
      const sellerApi = createWalmartSellerApi({ clientId: sellerId2, clientSecret: sellerSecret2 });
      const result = await sellerApi.updatePrice(input.sku as string, input.price as number);
      return { status: 'ok', feedId: result.feedId, feedStatus: result.feedStatus };
    }

    case 'walmart_update_inventory': {
      const wCreds3 = creds.walmart as Record<string, unknown> | undefined;
      const sellerId3 = (wCreds3?.sellerClientId as string | undefined);
      const sellerSecret3 = (wCreds3?.sellerClientSecret as string | undefined);
      if (!sellerId3 || !sellerSecret3) {
        return { status: 'error', message: 'Walmart Marketplace seller credentials not configured.' };
      }
      const sellerApi = createWalmartSellerApi({ clientId: sellerId3, clientSecret: sellerSecret3 });
      const result = await sellerApi.updateInventory(input.sku as string, input.quantity as number);
      return { status: 'ok', feedId: result.feedId, feedStatus: result.feedStatus };
    }

    case 'walmart_get_inventory': {
      const wCreds4 = creds.walmart as Record<string, unknown> | undefined;
      const sellerId4 = (wCreds4?.sellerClientId as string | undefined);
      const sellerSecret4 = (wCreds4?.sellerClientSecret as string | undefined);
      if (!sellerId4 || !sellerSecret4) {
        return { status: 'error', message: 'Walmart Marketplace seller credentials not configured.' };
      }
      const sellerApi = createWalmartSellerApi({ clientId: sellerId4, clientSecret: sellerSecret4 });
      const inv = await sellerApi.getInventory(input.sku as string);
      if (!inv) {
        return { status: 'error', message: `Inventory not found for SKU ${input.sku}` };
      }
      return { status: 'ok', sku: inv.sku, quantity: inv.quantity.amount, unit: inv.quantity.unit, fulfillmentLagTime: inv.fulfillmentLagTime };
    }

    case 'walmart_get_orders': {
      const wCreds5 = creds.walmart as Record<string, unknown> | undefined;
      const sellerId5 = (wCreds5?.sellerClientId as string | undefined);
      const sellerSecret5 = (wCreds5?.sellerClientSecret as string | undefined);
      if (!sellerId5 || !sellerSecret5) {
        return { status: 'error', message: 'Walmart Marketplace seller credentials not configured.' };
      }
      const sellerApi = createWalmartSellerApi({ clientId: sellerId5, clientSecret: sellerSecret5 });
      const orders = await sellerApi.getOrders({
        status: input.status as string | undefined,
        createdStartDate: input.createdStartDate as string | undefined,
        limit: typeof input.limit === 'number' ? input.limit : 50,
      });
      return {
        status: 'ok',
        orders: orders.map(o => ({
          purchaseOrderId: o.purchaseOrderId,
          customerOrderId: o.customerOrderId,
          orderDate: o.orderDate,
          lineItems: o.orderLines?.length ?? 0,
          shippingName: o.shippingInfo?.postalAddress?.name,
          shippingCity: o.shippingInfo?.postalAddress?.city,
          shippingState: o.shippingInfo?.postalAddress?.state,
        })),
        count: orders.length,
      };
    }

    case 'walmart_ship_order': {
      const wCreds6 = creds.walmart as Record<string, unknown> | undefined;
      const sellerId6 = (wCreds6?.sellerClientId as string | undefined);
      const sellerSecret6 = (wCreds6?.sellerClientSecret as string | undefined);
      if (!sellerId6 || !sellerSecret6) {
        return { status: 'error', message: 'Walmart Marketplace seller credentials not configured.' };
      }
      const sellerApi = createWalmartSellerApi({ clientId: sellerId6, clientSecret: sellerSecret6 });
      // Get order to find line items
      const order = await sellerApi.getOrder(input.purchaseOrderId as string);
      if (!order) {
        return { status: 'error', message: `Order ${input.purchaseOrderId} not found.` };
      }
      const lineItems = order.orderLines.map(ol => ({
        lineNumber: ol.lineNumber,
        quantity: parseInt(ol.orderLineQuantity.amount, 10) || 1,
      }));
      const success = await sellerApi.shipOrder(input.purchaseOrderId as string, {
        lineItems,
        carrier: input.carrier as string,
        trackingNumber: input.trackingNumber as string,
        methodCode: (input.methodCode as string) ?? 'Standard',
      });
      return {
        status: success ? 'ok' : 'error',
        message: success
          ? `Order ${input.purchaseOrderId} shipped with ${input.carrier} tracking ${input.trackingNumber}`
          : 'Failed to update shipping on Walmart.',
      };
    }

    case 'walmart_retire_item': {
      const wCreds7 = creds.walmart as Record<string, unknown> | undefined;
      const sellerId7 = (wCreds7?.sellerClientId as string | undefined);
      const sellerSecret7 = (wCreds7?.sellerClientSecret as string | undefined);
      if (!sellerId7 || !sellerSecret7) {
        return { status: 'error', message: 'Walmart Marketplace seller credentials not configured.' };
      }
      const sellerApi = createWalmartSellerApi({ clientId: sellerId7, clientSecret: sellerSecret7 });
      const success = await sellerApi.retireItem(input.sku as string);
      return {
        status: success ? 'ok' : 'error',
        message: success ? `Item ${input.sku} retired from Walmart.` : `Failed to retire item ${input.sku}.`,
      };
    }

    // -----------------------------------------------------------------------
    // Cross-platform utility tools
    // -----------------------------------------------------------------------
    case 'batch_reprice': {
      const strategy = input.strategy as string;
      const listingIdsStr = input.listingIds as string | undefined;
      const listings = listingIdsStr
        ? listingIdsStr.split(',').map(id => {
            const rows = context.db.query<Record<string, unknown>>(
              'SELECT id, platform, platform_listing_id, price, product_id, source_platform, source_price FROM listings WHERE id = ? AND status = ?',
              [id.trim(), 'active'],
            );
            return rows[0];
          }).filter(Boolean) as Array<Record<string, unknown>>
        : context.db.query<Record<string, unknown>>(
            'SELECT id, platform, platform_listing_id, price, product_id, source_platform, source_price FROM listings WHERE status = ? LIMIT 50',
            ['active'],
          );

      let repriced = 0;
      const results: Array<{ listingId: string; oldPrice: number; newPrice: number }> = [];

      for (const listing of listings) {
        const oldPrice = listing.price as number;
        let newPrice = oldPrice;

        if (strategy === 'undercut') {
          // Find competitor prices
          const competitorPrices = context.db.query<{ price: number; shipping: number }>(
            'SELECT price, shipping FROM prices WHERE product_id = ? AND platform = ? ORDER BY fetched_at DESC LIMIT 1',
            [listing.product_id, listing.platform],
          );
          if (competitorPrices.length > 0) {
            const lowestCompetitor = competitorPrices[0].price + competitorPrices[0].shipping;
            const undercut = typeof input.undercutAmount === 'number' ? input.undercutAmount : 0.01;
            newPrice = Math.round((lowestCompetitor - undercut) * 100) / 100;
          }
        } else if (strategy === 'fixed_margin') {
          const sourcePrice = listing.source_price as number;
          const targetMargin = typeof input.marginPct === 'number' ? input.marginPct : 20;
          if (sourcePrice > 0) {
            newPrice = Math.round((sourcePrice / (1 - targetMargin / 100)) * 100) / 100;
          }
        } else if (strategy === 'match') {
          const competitorPrices = context.db.query<{ price: number; shipping: number }>(
            'SELECT price, shipping FROM prices WHERE product_id = ? AND platform = ? ORDER BY fetched_at DESC LIMIT 1',
            [listing.product_id, listing.platform],
          );
          if (competitorPrices.length > 0) {
            newPrice = competitorPrices[0].price + competitorPrices[0].shipping;
          }
        }

        if (newPrice !== oldPrice && newPrice > 0) {
          context.db.run(
            'UPDATE listings SET price = ?, updated_at = ? WHERE id = ?',
            [newPrice, Date.now(), listing.id],
          );

          // Update on platform if eBay
          if (listing.platform === 'ebay' && creds.ebay?.refreshToken && listing.platform_listing_id) {
            try {
              const seller = createEbaySellerApi(creds.ebay);
              await seller.updateOfferPrice(listing.platform_listing_id as string, newPrice);
            } catch {
              // DB already updated, platform update is best-effort
            }
          }

          repriced++;
          results.push({
            listingId: listing.id as string,
            oldPrice,
            newPrice,
          });
        }
      }

      return {
        status: 'ok',
        strategy,
        totalListings: listings.length,
        repriced,
        results: results.slice(0, 20),
      };
    }

    case 'inventory_sync': {
      const listingIdsStr = input.listingIds as string | undefined;
      const listings = listingIdsStr
        ? listingIdsStr.split(',').map(id => {
            const rows = context.db.query<Record<string, unknown>>(
              'SELECT id, product_id, source_platform, platform, platform_listing_id FROM listings WHERE id = ? AND status = ?',
              [id.trim(), 'active'],
            );
            return rows[0];
          }).filter(Boolean) as Array<Record<string, unknown>>
        : context.db.query<Record<string, unknown>>(
            'SELECT id, product_id, source_platform, platform, platform_listing_id FROM listings WHERE status = ? LIMIT 50',
            ['active'],
          );

      let synced = 0;
      let outOfStock = 0;
      const syncResults: Array<{ listingId: string; productId: string; sourcePlatform: string; inStock: boolean }> = [];

      for (const listing of listings) {
        const sourcePlatform = listing.source_platform as Platform;
        const productId = listing.product_id as string;

        try {
          const adapter = getAdapter(sourcePlatform, creds);
          const stock = await adapter.checkStock(productId);

          syncResults.push({
            listingId: listing.id as string,
            productId,
            sourcePlatform,
            inStock: stock.inStock,
          });

          if (!stock.inStock) {
            outOfStock++;
            // Pause listings for out-of-stock products
            context.db.updateListingStatus(listing.id as string, 'paused');
            logger.info({ listingId: listing.id, productId }, 'Paused listing — source product out of stock');
          }

          synced++;
        } catch (err) {
          logger.warn({ listingId: listing.id, error: err instanceof Error ? err.message : String(err) }, 'Stock check failed during sync');
        }
      }

      return {
        status: 'ok',
        totalListings: listings.length,
        synced,
        outOfStock,
        results: syncResults.slice(0, 20),
      };
    }

    // -----------------------------------------------------------------------
    // Unknown tool
    // -----------------------------------------------------------------------
    default:
      logger.warn({ toolName }, 'Unknown tool called');
      return { error: `Unknown tool: ${toolName}` };
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createAgentManager(deps: {
  config: Config;
  db: Database;
  sessionManager: SessionManager;
  skills?: SkillManager;
  credentials: CredentialsManager;
  sendMessage?: (msg: OutgoingMessage) => Promise<string | null>;
}): AgentManager {
  const { db, sessionManager, credentials } = deps;
  let config = deps.config;

  // Default skill manager (no-op) if none provided
  const skills: SkillManager = deps.skills ?? {
    getSkillContext: () => '',
    getCommands: () => [],
    reload: () => {},
  };

  // Default sendMessage returns the text (gateway handles actual sending)
  const sendMessage = deps.sendMessage ?? (async (msg: OutgoingMessage) => msg.text);

  // ---------------------------------------------------------------------------
  // Anthropic client
  // ---------------------------------------------------------------------------

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set -- agent will not be able to respond');
  }

  const client = new Anthropic({ apiKey: apiKey ?? 'missing' });

  // ---------------------------------------------------------------------------
  // Tool registry
  // ---------------------------------------------------------------------------

  const allTools = defineTools();
  const registry = new ToolRegistry<ToolDefinition>();
  registry.registerAll(allTools);

  logger.info(
    { total: registry.size(), core: CORE_TOOL_NAMES.size },
    'Tool registry initialized',
  );

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  async function handleMessage(
    message: IncomingMessage,
    session: Session,
  ): Promise<string | null> {
    const text = message.text.trim();
    if (!text) return null;

    // Add user message to history
    sessionManager.addToHistory(session, 'user', text);

    // Build system prompt
    const skillContext = skills.getSkillContext(text);
    const systemPrompt = SYSTEM_PROMPT.replace('{{SKILLS}}', skillContext);

    // Build conversation messages for the API
    const history = sessionManager.getHistory(session);
    const apiMessages: Anthropic.MessageParam[] = [];

    // Include context summary if present
    if (session.context.contextSummary) {
      apiMessages.push({
        role: 'user',
        content: `[Previous conversation summary: ${session.context.contextSummary}]`,
      });
      apiMessages.push({
        role: 'assistant',
        content: 'I understand the context from our previous conversation. How can I help?',
      });
    }

    // Add conversation history
    for (const msg of history) {
      apiMessages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    // Ensure messages alternate properly (Anthropic requires user/assistant alternation)
    // and that the first message is from the user
    const cleanedMessages = ensureAlternatingRoles(apiMessages);

    // Select tools based on message intent
    const selectedTools = selectTools(registry, text);

    logger.debug(
      { tools: selectedTools.length, user: message.userId },
      'Calling Anthropic API',
    );

    // Resolve model name: strip "anthropic/" prefix if present
    const rawModel = config.agents.defaults.model?.primary ?? 'claude-sonnet-4-5-20250929';
    const model = rawModel.replace(/^anthropic\//, '');

    // -----------------------------------------------------------------------
    // Agentic loop: call API, execute tools, loop until text response
    // -----------------------------------------------------------------------

    let currentMessages = cleanedMessages;
    let iterations = 0;
    const MAX_ITERATIONS = 10;
    let finalText = '';

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      let response: Anthropic.Message;
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: currentMessages,
          tools: toApiTools(selectedTools),
        });
        response = await stream.finalMessage();
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err: errMsg, iteration: iterations }, 'Anthropic API error');

        // Handle prompt too long gracefully
        if (errMsg.includes('prompt is too long') || errMsg.includes('max_tokens')) {
          finalText = 'I apologize, but the conversation has grown too long. Please start a new conversation with /new.';
          break;
        }

        finalText = 'Sorry, I encountered an error processing your request. Please try again.';
        break;
      }

      // Collect text and tool_use blocks from response
      const textBlocks: string[] = [];
      const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textBlocks.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      // If no tool calls, we're done
      if (toolUseBlocks.length === 0) {
        finalText = textBlocks.join('\n');
        break;
      }

      // Execute all tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolCall of toolUseBlocks) {
        logger.debug({ tool: toolCall.name, iteration: iterations }, 'Executing tool');

        let result: unknown;
        try {
          result = await executeTool(toolCall.name, toolCall.input, {
            registry,
            db,
            credentials,
            userId: session.userId,
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error({ tool: toolCall.name, err: errMsg }, 'Tool execution error');
          result = { error: `Tool execution failed: ${errMsg}` };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      // Build the next set of messages: append assistant response + tool results
      currentMessages = [
        ...currentMessages,
        { role: 'assistant' as const, content: response.content },
        { role: 'user' as const, content: toolResults },
      ];

      // If stop_reason is end_turn after tool use (shouldn't happen, but defensive)
      if (response.stop_reason === 'end_turn' && textBlocks.length > 0) {
        finalText = textBlocks.join('\n');
        break;
      }
    }

    if (iterations >= MAX_ITERATIONS) {
      logger.warn({ userId: session.userId }, 'Agent hit max iterations');
      finalText += '\n\n(Reached maximum tool call iterations.)';
    }

    // Save assistant response to history
    if (finalText) {
      sessionManager.addToHistory(session, 'assistant', finalText);
    }

    // Send the response
    if (finalText) {
      return sendMessage({
        platform: message.platform,
        chatId: message.chatId,
        text: finalText,
        replyToMessageId: message.id,
      });
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function dispose(): void {
    logger.info('Agent manager disposed');
  }

  function reloadSkills(): void {
    skills.reload();
    logger.info('Skills reloaded');
  }

  function reloadConfig(newConfig: Config): void {
    config = newConfig;
    logger.info('Agent config reloaded');
  }

  function getSkillCommands(): Array<{ name: string; description: string }> {
    return skills.getCommands();
  }

  return {
    handleMessage,
    dispose,
    reloadSkills,
    reloadConfig,
    getSkillCommands,
  };
}

// =============================================================================
// UTILS
// =============================================================================

/**
 * Ensure messages alternate between user and assistant roles.
 * Anthropic API requires strict alternation with the first message being user.
 *
 * Merges consecutive same-role messages into one by joining with newline.
 */
function ensureAlternatingRoles(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return [];

  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    const last = result[result.length - 1];

    if (last && last.role === msg.role) {
      // Merge consecutive same-role text messages
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content = last.content + '\n' + msg.content;
      }
      // If either is non-string (tool blocks), just skip the merge and keep both
      // by converting to array content -- but for simplicity we leave the last one
      continue;
    }

    result.push({ ...msg });
  }

  // Ensure first message is from user
  if (result.length > 0 && result[0].role !== 'user') {
    result.unshift({
      role: 'user',
      content: '(conversation start)',
    });
  }

  // Ensure last message is from user (required by API)
  if (result.length > 0 && result[result.length - 1].role !== 'user') {
    // This shouldn't happen in normal flow since we always add user msg last
    // but defensive check
  }

  return result;
}
