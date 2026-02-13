/**
 * eBay Finances API — Transaction history, payouts, fees
 *
 * Endpoints:
 * - GET /sell/finances/v1/transaction — list transactions (sales, refunds, credits)
 * - GET /sell/finances/v1/payout — list payouts
 * - GET /sell/finances/v1/payout/{payout_id} — payout detail
 * - GET /sell/finances/v1/seller_funds_summary — available/processing/hold balance
 */

import { createLogger } from '../../utils/logger';
import type { EbayCredentials } from '../../types';
import { getAccessToken, API_BASE } from './auth';

const logger = createLogger('ebay-finances');

export interface EbayTransaction {
  transactionId: string;
  transactionType: string;
  transactionStatus: string;
  orderId?: string;
  amount: { value: string; currency: string };
  totalFeeBasisAmount?: { value: string; currency: string };
  totalFeeAmount?: { value: string; currency: string };
  orderLineItems?: Array<{
    lineItemId: string;
    feeBasisAmount?: { value: string; currency: string };
    marketplaceFees?: Array<{ feeType: string; amount: { value: string; currency: string } }>;
  }>;
  transactionDate: string;
  buyerUsername?: string;
  paymentsEntity?: string;
  payoutId?: string;
}

export interface EbayPayout {
  payoutId: string;
  payoutStatus: string;
  payoutStatusDescription?: string;
  amount: { value: string; currency: string };
  payoutDate: string;
  lastAttemptedPayoutDate?: string;
  transactionCount: number;
  payoutInstrument?: { instrumentType: string; nickname?: string; accountLastFourDigits?: string };
}

export interface EbayFundsSummary {
  availableFunds: { value: string; currency: string };
  fundsOnHold: { value: string; currency: string };
  processingFunds: { value: string; currency: string };
  totalFunds: { value: string; currency: string };
}

export interface EbayFinancesApi {
  getTransactions(params?: {
    filter?: string;
    sort?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ transactions: EbayTransaction[]; total: number }>;

  getPayouts(params?: {
    filter?: string;
    sort?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ payouts: EbayPayout[]; total: number }>;

  getPayout(payoutId: string): Promise<EbayPayout | null>;

  getFundsSummary(): Promise<EbayFundsSummary | null>;
}

export function createEbayFinancesApi(credentials: EbayCredentials): EbayFinancesApi {
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
    async getTransactions(params?) {
      const token = await getToken();
      const qp = new URLSearchParams();
      if (params?.filter) qp.set('filter', params.filter);
      if (params?.sort) qp.set('sort', params.sort);
      qp.set('limit', String(params?.limit ?? 50));
      qp.set('offset', String(params?.offset ?? 0));

      const response = await fetch(
        `${baseUrl}/sell/finances/v1/transaction?${qp.toString()}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to get transactions');
        throw new Error(`eBay get transactions failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { transactions?: EbayTransaction[]; total?: number };
      return { transactions: data.transactions ?? [], total: data.total ?? 0 };
    },

    async getPayouts(params?) {
      const token = await getToken();
      const qp = new URLSearchParams();
      if (params?.filter) qp.set('filter', params.filter);
      if (params?.sort) qp.set('sort', params.sort);
      qp.set('limit', String(params?.limit ?? 50));
      qp.set('offset', String(params?.offset ?? 0));

      const response = await fetch(
        `${baseUrl}/sell/finances/v1/payout?${qp.toString()}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to get payouts');
        throw new Error(`eBay get payouts failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { payouts?: EbayPayout[]; total?: number };
      return { payouts: data.payouts ?? [], total: data.total ?? 0 };
    },

    async getPayout(payoutId) {
      const token = await getToken();
      const response = await fetch(
        `${baseUrl}/sell/finances/v1/payout/${encodeURIComponent(payoutId)}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );

      if (!response.ok) {
        if (response.status === 404) return null;
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to get payout');
        return null;
      }

      return await response.json() as EbayPayout;
    },

    async getFundsSummary() {
      const token = await getToken();
      const response = await fetch(
        `${baseUrl}/sell/finances/v1/seller_funds_summary`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Failed to get funds summary');
        return null;
      }

      return await response.json() as EbayFundsSummary;
    },
  };
}
