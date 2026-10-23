import type { APIRequestContext, APIResponse } from '@playwright/test';
import { body } from './client';

/** The shape `formatTrade` returns — every field, camelCase, dates as ISO. */
export interface Trade {
  id: string;
  userId: string;
  symbol: string;
  side: 'buy' | 'sell';
  status: 'open' | 'closed';
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  leverage: number | null;
  pnl: number | null;
  fee: number;
  stopLoss: number | null;
  takeProfit: number | null;
  notes: string | null;
  tags: string[];
  openedAt: string | null;
  closedAt: string | null;
  sourcePlatform: string | null;
  sourceAccountId: string | null;
  sourceTradeId: string | null;
  importMethod: string | null;
  importBatchId: string | null;
}

/** What `POST /trades` and each row of `POST /trades/bulk` accept. */
export interface TradeInput {
  symbol: string;
  side?: 'buy' | 'sell';
  status?: 'open' | 'closed';
  entryPrice: number;
  exitPrice?: number;
  size: number;
  leverage?: number;
  pnl?: number;
  fee?: number;
  stopLoss?: number;
  takeProfit?: number;
  notes?: string;
  tags?: string[];
  openedAt: string;
  closedAt?: string;
  marketType?: string;
  sourcePlatform?: string;
  sourceAccountId?: string;
  sourceTradeId?: string;
  importMethod?: string;
  importBatchId?: string;
}

export interface BulkResult {
  imported: number;
  skippedDuplicates: number;
  failed: { row: number; message: string }[];
}

export function listTrades(
  api: APIRequestContext,
  params: { limit?: number; offset?: number } = {},
): Promise<APIResponse> {
  return api.get('trades', { params: params as Record<string, number> });
}

export function createTrade(api: APIRequestContext, data: unknown): Promise<APIResponse> {
  return api.post('trades', { data: data as Record<string, unknown> });
}

export function getTrade(api: APIRequestContext, id: string): Promise<APIResponse> {
  return api.get(`trades/${id}`);
}

export function updateTrade(
  api: APIRequestContext,
  id: string,
  data: unknown,
): Promise<APIResponse> {
  return api.put(`trades/${id}`, { data: data as Record<string, unknown> });
}

export function deleteTrade(api: APIRequestContext, id: string): Promise<APIResponse> {
  return api.delete(`trades/${id}`);
}

export function bulkImport(api: APIRequestContext, trades: unknown[]): Promise<APIResponse> {
  return api.post('trades/bulk', { data: { trades } });
}

export function bulkDelete(
  api: APIRequestContext,
  payload: { ids: string[] } | { importBatchId: string },
): Promise<APIResponse> {
  return api.post('trades/bulk-delete', { data: payload });
}

/** Seeds a set of trades and returns them as the API now reports them. */
export async function seedTrades(
  api: APIRequestContext,
  inputs: TradeInput[],
): Promise<Trade[]> {
  const created: Trade[] = [];
  for (const input of inputs) {
    const response = await createTrade(api, input);
    if (!response.ok()) {
      throw new Error(
        `Seeding ${input.symbol} failed: ${response.status()} ${await response.text()}`,
      );
    }
    created.push(await body<Trade>(response));
  }
  return created;
}

/**
 * Every trade the caller owns, paged.
 *
 * One call with a large `limit` is not enough, and the difference misleads: the
 * chunking test imports 601 rows, and a one-shot `limit: 500` returned exactly
 * 500 — which reads as "the second chunk never landed" rather than "the helper
 * stopped asking".
 */
export async function allTrades(api: APIRequestContext): Promise<Trade[]> {
  const PAGE = 200;
  const collected: Trade[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const response = await listTrades(api, { limit: PAGE, offset });
    if (!response.ok()) {
      throw new Error(`GET /trades failed: ${response.status()} ${await response.text()}`);
    }
    const page = await body<Trade[]>(response);
    collected.push(...page);
    if (page.length < PAGE) return collected;

    // A journal is capped well below this; looping forever on an endpoint that
    // stopped honouring `offset` would be a worse failure than an error.
    if (offset > 20_000) throw new Error('GET /trades paged past 20k rows — refusing to loop');
  }
}
