/**
 * Gateway - Orchestrates all FlipAgent services
 *
 * Initializes: DB, credentials, sessions, agent, channels, hooks, cron, queue, HTTP server.
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger';
import { createServer } from './server';
import { createDatabase, initDatabase } from '../db';
import { createSessionManager } from '../sessions';
import { createAgentManager } from '../agents';
import { createChannelManager } from '../channels';
import { createCredentialsManager } from '../credentials';
import { hooks } from '../hooks';
import { CronScheduler, registerBuiltInJobs } from '../cron';
import { MessageQueue } from '../queue';
import { setupShutdownHandlers } from '../utils/production';
import { scanForArbitrage } from '../arbitrage/scanner';
import { createOrderMonitor } from '../fulfillment/monitor';
import { createAmazonAdapter } from '../platforms/amazon/scraper';
import { createEbayAdapter } from '../platforms/ebay/scraper';
import { createWalmartAdapter } from '../platforms/walmart/scraper';
import { createAliExpressAdapter } from '../platforms/aliexpress/scraper';
import type { Config, IncomingMessage, OutgoingMessage, Platform, AmazonCredentials, EbayCredentials, WalmartCredentials, AliExpressCredentials } from '../types';
import type { Database } from '../db';
import type { PlatformAdapter } from '../platforms/index';

const logger = createLogger('gateway');

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createGateway(config: Config): Promise<Gateway> {
  logger.info('Initializing FlipAgent gateway...');

  // 1. Initialize database
  const db = await createDatabase();
  initDatabase(db);
  logger.info('Database initialized');

  // 2. Create credentials manager
  const credentials = createCredentialsManager(db);

  // 3. Create session manager
  const sessionManager = createSessionManager(db, config.session);
  logger.info('Session manager initialized');

  // 4. Create agent manager
  const agentManager = createAgentManager({
    config,
    db,
    sessionManager,
    credentials,
  });
  logger.info('Agent manager initialized');

  // 5. Create message queue
  const queue = new MessageQueue({
    mode: 'debounce',
    debounceMs: 1500,
    maxBatchSize: 5,
  });

  // 6. Create channel manager
  const channelManager = await createChannelManager(config.channels, {
    onMessage: async (message: IncomingMessage) => {
      // Emit message:before hook (can cancel or modify)
      const hookCtx = await hooks.emit('message:before', { message });
      if (hookCtx.cancelled) return;
      const processedMessage = hookCtx.message?.text
        ? { ...message, text: hookCtx.message.text as string }
        : message;

      const session = await sessionManager.getOrCreateSession(processedMessage);
      const response = await agentManager.handleMessage(processedMessage, session);
      if (response) {
        await channelManager.send({
          platform: processedMessage.platform,
          chatId: processedMessage.chatId,
          text: response,
        });

        // Emit message:after hook
        await hooks.emit('message:after', {
          message: { text: processedMessage.text } as any,
          response: { text: response } as any,
        });
      }
    },
  });
  queue.setHandler(async (messages) => {
    // Process batched messages — use the last one's metadata, concatenate text
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    const combined: IncomingMessage = {
      ...last,
      text: messages.map(m => m.text).join('\n\n'),
    };
    const session = await sessionManager.getOrCreateSession(combined);
    const response = await agentManager.handleMessage(combined, session);
    if (response) {
      await channelManager.send({
        platform: combined.platform,
        chatId: combined.chatId,
        text: response,
      });
    }
  });
  logger.info('Channel manager initialized');

  // Helper: build platform adapters from stored credentials for a system user
  function buildAdapters(): Map<Platform, PlatformAdapter> {
    const adapters = new Map<Platform, PlatformAdapter>();
    const systemUser = 'system';

    const amz = credentials.getCredentials<AmazonCredentials>(systemUser, 'amazon');
    adapters.set('amazon', createAmazonAdapter(amz ?? undefined));

    const ebay = credentials.getCredentials<EbayCredentials>(systemUser, 'ebay');
    adapters.set('ebay', createEbayAdapter(ebay ?? undefined));

    const wmt = credentials.getCredentials<WalmartCredentials>(systemUser, 'walmart');
    adapters.set('walmart', createWalmartAdapter(wmt ?? undefined));

    const ali = credentials.getCredentials<AliExpressCredentials>(systemUser, 'aliexpress');
    adapters.set('aliexpress', createAliExpressAdapter(ali ?? undefined));

    return adapters;
  }

  // Create order monitor for the checkOrders cron
  const ebayCreds = credentials.getCredentials<EbayCredentials>('system', 'ebay');
  const orderMonitor = createOrderMonitor(db, ebayCreds ? { ebay: ebayCreds } : undefined);

  // 7. Create cron scheduler with built-in jobs
  const cron = new CronScheduler();
  registerBuiltInJobs(cron, {
    scanPrices: async () => {
      logger.info('Cron: scan_prices tick');
      try {
        const adapters = buildAdapters();
        const opps = await scanForArbitrage(adapters, { minMarginPct: 15, maxResults: 50 });
        for (const opp of opps) {
          db.addOpportunity({
            id: randomUUID().slice(0, 12),
            productId: opp.productId,
            buyPlatform: opp.buyPlatform,
            buyPrice: opp.buyPrice,
            buyShipping: opp.buyShipping,
            sellPlatform: opp.sellPlatform,
            sellPrice: opp.sellPrice,
            estimatedFees: opp.estimatedFees,
            estimatedProfit: opp.estimatedProfit,
            marginPct: opp.marginPct,
            score: opp.score,
            status: 'active',
            foundAt: new Date(),
          });
        }
        logger.info({ found: opps.length }, 'Cron: scan_prices complete');
      } catch (err) {
        logger.error({ err }, 'Cron: scan_prices failed');
      }
    },
    checkOrders: async () => {
      logger.info('Cron: check_orders tick');
      try {
        const count = await orderMonitor.checkOrders();
        if (count > 0) logger.info({ newOrders: count }, 'Cron: check_orders found new orders');
      } catch (err) {
        logger.error({ err }, 'Cron: check_orders failed');
      }
    },
    repriceCheck: async () => {
      logger.info('Cron: reprice_check tick');
      try {
        const listings = db.getActiveListings();
        if (listings.length === 0) return;
        const adapters = buildAdapters();
        let repriced = 0;
        for (const listing of listings) {
          const adapter = adapters.get(listing.platform);
          if (!adapter) continue;
          try {
            const results = await adapter.search({ query: listing.title ?? listing.productId, maxResults: 5 });
            const competitorPrices = results
              .filter(r => r.price > 0)
              .map(r => r.price);
            if (competitorPrices.length > 0) {
              const avgPrice = competitorPrices.reduce((a, b) => a + b, 0) / competitorPrices.length;
              // Flag listings where our price is >20% above average
              if (listing.price > avgPrice * 1.2) {
                logger.warn({
                  listingId: listing.id,
                  ourPrice: listing.price,
                  avgCompetitor: Math.round(avgPrice * 100) / 100,
                }, 'Listing may be overpriced');
                repriced++;
              }
            }
          } catch (err) {
            logger.debug({ listingId: listing.id, err }, 'Reprice check failed for listing');
          }
        }
        logger.info({ checked: listings.length, flagged: repriced }, 'Cron: reprice_check complete');
      } catch (err) {
        logger.error({ err }, 'Cron: reprice_check failed');
      }
    },
    inventorySync: async () => {
      logger.info('Cron: inventory_sync tick');
      try {
        // Check active listings against source platform stock
        const listings = db.getActiveListings();
        const adapters = buildAdapters();
        let synced = 0;
        for (const listing of listings) {
          if (!listing.productId) continue;
          const sourceAdapter = adapters.get(listing.sourcePlatform);
          if (!sourceAdapter) continue;
          try {
            const product = await sourceAdapter.getProduct(listing.productId);
            if (product && !product.inStock) {
              db.updateListingStatus(listing.id, 'paused');
              logger.warn({ listingId: listing.id, productId: listing.productId }, 'Source OOS — listing paused');
              synced++;
            }
          } catch {
            // Source lookup failed — skip silently
          }
        }
        logger.info({ checked: listings.length, paused: synced }, 'Cron: inventory_sync complete');
      } catch (err) {
        logger.error({ err }, 'Cron: inventory_sync failed');
      }
    },
    sessionCleanup: async () => {
      logger.info('Cron: session_cleanup tick');
      // Session manager handles its own cleanup via dispose intervals,
      // but we also clean expired sessions from the DB
      try {
        const cutoffMs = 30 * 24 * 60 * 60 * 1000; // 30 days
        const cutoffDate = new Date(Date.now() - cutoffMs).toISOString();
        db.run('DELETE FROM sessions WHERE updated_at < ?', [cutoffDate]);
        logger.info('Cron: session_cleanup complete');
      } catch (err) {
        logger.error({ err }, 'Cron: session_cleanup failed');
      }
    },
    dbBackup: async () => { db.save(); },
  });
  logger.info('Cron scheduler initialized');

  // 8. Create HTTP + WebSocket server
  const httpServer = createServer(
    {
      port: config.gateway.port,
      authToken: process.env.FLIPAGENT_TOKEN,
      cors: { origins: true },
      rateLimitPerMinute: parseInt(process.env.FLIPAGENT_IP_RATE_LIMIT ?? '100', 10) || 100,
      hstsEnabled: process.env.FLIPAGENT_HSTS_ENABLED === 'true',
      forceHttps: process.env.FLIPAGENT_FORCE_HTTPS === 'true',
    },
    {
      onChatConnection: channelManager.getChatConnectionHandler() || undefined,
      db,
    },
  );

  // 9. Attach WebSocket to channel manager
  channelManager.attachWebSocket(httpServer.wss);

  let started = false;

  return {
    async start() {
      if (started) return;
      await httpServer.start();
      await channelManager.start();
      cron.start();

      // Emit gateway:start hook
      await hooks.emit('gateway:start');

      started = true;
      logger.info({ port: config.gateway.port }, 'FlipAgent gateway started');
    },

    async stop() {
      if (!started) return;
      logger.info('Shutting down FlipAgent gateway...');

      // Emit gateway:stop hook
      await hooks.emit('gateway:stop');

      cron.stop();
      queue.dispose();
      await channelManager.stop();
      await httpServer.stop();
      db.close();
      sessionManager.dispose();
      agentManager.dispose();
      started = false;
      logger.info('FlipAgent gateway stopped');
    },
  };
}
