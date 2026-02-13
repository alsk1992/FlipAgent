/**
 * FlipAgent Core Types
 */

// =============================================================================
// PLATFORMS
// =============================================================================

export type Platform = 'amazon' | 'ebay' | 'walmart' | 'aliexpress';

export const ALL_PLATFORMS: Platform[] = ['amazon', 'ebay', 'walmart', 'aliexpress'];

// =============================================================================
// PRODUCTS
// =============================================================================

export interface Product {
  id: string;
  upc?: string;
  asin?: string;
  title: string;
  brand?: string;
  category?: string;
  imageUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PriceSnapshot {
  id?: number;
  productId: string;
  platform: Platform;
  platformId?: string;  // ASIN, eBay item ID, etc.
  price: number;
  shipping: number;
  currency: string;
  inStock: boolean;
  seller?: string;
  url?: string;
  fetchedAt: Date;
}

// =============================================================================
// ARBITRAGE
// =============================================================================

export interface Opportunity {
  id: string;
  productId: string;
  buyPlatform: Platform;
  buyPrice: number;
  buyShipping: number;
  sellPlatform: Platform;
  sellPrice: number;
  estimatedFees: number;
  estimatedProfit: number;
  marginPct: number;
  score: number;
  status: 'active' | 'listed' | 'expired' | 'sold';
  foundAt: Date;
  expiresAt?: Date;
}

// =============================================================================
// LISTINGS
// =============================================================================

export interface Listing {
  id: string;
  opportunityId?: string;
  productId: string;
  platform: Platform;
  platformListingId?: string;
  title?: string;
  price: number;
  sourcePlatform: Platform;
  sourcePrice: number;
  status: 'active' | 'paused' | 'sold' | 'expired';
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// ORDERS
// =============================================================================

export interface Order {
  id: string;
  listingId: string;
  sellPlatform: Platform;
  sellOrderId?: string;
  sellPrice: number;
  buyPlatform: Platform;
  buyOrderId?: string;
  buyPrice?: number;
  shippingCost?: number;
  platformFees?: number;
  profit?: number;
  status: 'pending' | 'purchased' | 'shipped' | 'delivered' | 'returned';
  buyerAddress?: string;
  trackingNumber?: string;
  orderedAt: Date;
  shippedAt?: Date;
  deliveredAt?: Date;
}

// =============================================================================
// SESSIONS & MESSAGING
// =============================================================================

export interface SessionContext {
  messageCount: number;
  preferences: Record<string, unknown>;
  conversationHistory: ConversationMessage[];
  contextSummary?: string;
  checkpoint?: {
    history: ConversationMessage[];
    savedAt: Date;
    summary?: string;
  };
  checkpointRestoredAt?: Date;
}

export interface Session {
  id: string;
  key: string;
  userId: string;
  platform: string;
  chatId: string;
  chatType: 'dm' | 'group';
  context: SessionContext;
  history: ConversationMessage[];
  lastActivity: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface IncomingMessage {
  id: string;
  platform: string;
  accountId?: string;
  chatId: string;
  chatType: 'dm' | 'group';
  userId: string;
  username?: string;
  displayName?: string;
  text: string;
  replyToMessageId?: string;
  timestamp: Date;
  attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  type: 'image' | 'file' | 'audio' | 'video';
  url?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
}

export interface OutgoingMessage {
  platform: string;
  chatId: string;
  text: string;
  replyToMessageId?: string;
  attachments?: MessageAttachment[];
}

export interface ReactionMessage {
  platform: string;
  chatId: string;
  messageId: string;
  emoji: string;
}

// =============================================================================
// CREDENTIALS
// =============================================================================

export interface UserCredentials {
  userId: string;
  platform: Platform;
  mode: string;
  encryptedData: string;
  enabled: boolean;
  failedAttempts: number;
  cooldownUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AmazonCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  partnerTag: string;
  marketplace?: string;
  sellerToken?: string;
  refreshToken?: string;
  /** LWA client ID for SP-API (Selling Partner API) */
  spClientId?: string;
  /** LWA client secret for SP-API */
  spClientSecret?: string;
  /** LWA refresh token for SP-API */
  spRefreshToken?: string;
}

export interface EbayCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  environment?: 'sandbox' | 'production';
}

export interface WalmartCredentials {
  clientId: string;
  clientSecret: string;
  consumerId?: string;
  /** Walmart Marketplace seller OAuth client ID */
  sellerClientId?: string;
  /** Walmart Marketplace seller OAuth client secret */
  sellerClientSecret?: string;
}

export interface AliExpressCredentials {
  appKey: string;
  appSecret: string;
  accessToken?: string;
}

export interface KeepaCredentials {
  apiKey: string;
  domainId?: number;
}

export interface EasyPostCredentials {
  apiKey: string;
}

export type PlatformCredentials =
  | AmazonCredentials
  | EbayCredentials
  | WalmartCredentials
  | AliExpressCredentials
  | KeepaCredentials
  | EasyPostCredentials;

// =============================================================================
// CONFIG
// =============================================================================

export interface Config {
  gateway: {
    port: number;
    auth: Record<string, unknown>;
  };
  agents: {
    defaults: {
      workspace?: string;
      model?: { primary: string };
    };
  };
  session: {
    cleanup?: {
      enabled: boolean;
      maxAgeDays: number;
      idleDays: number;
    };
    dmScope?: string;
    reset?: {
      mode?: string;
      atHour?: number;
      idleMinutes?: number;
    };
    resetTriggers?: string[];
  };
  channels: {
    webchat?: {
      enabled: boolean;
      authToken?: string;
    };
  };
  http: {
    enabled?: boolean;
    defaultRateLimit?: { maxRequests: number; windowMs: number };
    perHost?: Record<string, { maxRequests: number; windowMs: number }>;
    retry?: {
      enabled?: boolean;
      maxAttempts?: number;
      minDelay?: number;
      maxDelay?: number;
      jitter?: number;
      backoffMultiplier?: number;
      methods?: string[];
    };
  };
  arbitrage: {
    enabled: boolean;
    scanIntervalMs: number;
    minMarginPct: number;
    maxResults: number;
    platforms: Platform[];
  };
}

// =============================================================================
// SKILL SYSTEM
// =============================================================================

export interface SkillGates {
  bins?: string[];
  anyBins?: string[];
  envs?: string[];
  os?: string[];
  config?: string[];
}

export interface Skill {
  name: string;
  description: string;
  path?: string;
  content: string;
  enabled: boolean;
  subcommands?: Array<{ name: string; description: string; category: string }>;
  emoji?: string;
  homepage?: string;
  primaryEnv?: string;
  skillKey?: string;
  always?: boolean;
  os?: string[];
  userInvocable?: boolean;
  modelInvocable?: boolean;
  baseDir?: string;
  commandDispatch?: string;
  commandTool?: string;
  commandArgMode?: string;
  binPaths?: string[];
  envOverrides?: Record<string, string>;
  install?: string;
}

export interface SkillManagerConfig {
  allowBundled?: string[];
  extraDirs?: string[];
  configKeys?: Record<string, unknown>;
  watchDebounceMs?: number;
}

// =============================================================================
// USER
// =============================================================================

export interface User {
  id: string;
  displayName?: string;
  platform?: string;
  platformUserId?: string;
  createdAt: Date;
  updatedAt: Date;
}
