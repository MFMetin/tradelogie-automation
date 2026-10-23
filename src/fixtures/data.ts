import type { APIRequestContext } from '@playwright/test';
import type { TradeInput, Trade } from '../api/trades';
import { allTrades, bulkDelete } from '../api/trades';

/**
 * One valid closed trade, with every required field filled.
 *
 * A factory rather than a constant so a test names only what it cares about —
 * `aTrade({ side: 'sell' })` reads as "a trade, but short", and a test that
 * spells out eleven fields to vary one of them hides which one mattered.
 *
 * The date is fixed. A `new Date()` default would make every assertion about
 * ordering or a date range depend on when the suite ran.
 */
export function aTrade(overrides: Partial<TradeInput> = {}): TradeInput {
  return {
    symbol: 'BTCUSDT',
    side: 'buy',
    status: 'closed',
    entryPrice: 50_000,
    exitPrice: 51_000,
    size: 0.1,
    pnl: 100,
    fee: 2,
    openedAt: '2026-01-15T10:00:00.000Z',
    closedAt: '2026-01-15T14:00:00.000Z',
    ...overrides,
  };
}

/**
 * Empties the caller's journal.
 *
 * The user fixture is worker-scoped — one account per worker rather than per
 * test, because creating one costs two admin mutations and the admin limiter
 * allows thirty a minute. The tradeoff is that tests sharing a worker share a
 * journal, so anything that asserts on a whole listing has to start from
 * nothing. Workers never share an account, so this is safe in parallel.
 */
export async function clearTrades(api: APIRequestContext): Promise<void> {
  const existing = await allTrades(api);
  if (existing.length === 0) return;

  // Capped at 1000 ids a call.
  for (let index = 0; index < existing.length; index += 1000) {
    const ids = existing.slice(index, index + 1000).map((trade) => trade.id);
    await bulkDelete(api, { ids });
  }
}

/**
 * A hand-computed set whose statistics are known without running the code that
 * computes them.
 *
 * `lib/analytics.ts` derives the equity curve, win rate, profit factor and the
 * by-symbol table on the client from `/trades` — there is no analytics endpoint
 * — so the UI's numbers can be checked against an oracle rather than against a
 * second implementation of the same arithmetic.
 *
 * Net of fees, which is what the app shows (`netPnl = pnl - fee`):
 *   +200-5 = +195   BTCUSDT  win
 *   +150-5 = +145   BTCUSDT  win
 *   -100-5 = -105   ETHUSDT  loss
 *    +80-5 =  +75   ETHUSDT  win
 *   -200-5 = -205   XAUUSD   loss
 *
 * Wins 3, losses 2        -> win rate 60%
 * Gross profit 415, gross loss 310 -> profit factor 415/310 = 1.3387...
 * Net total +105
 */
export const KNOWN_SET: TradeInput[] = [
  aTrade({
    symbol: 'BTCUSDT',
    pnl: 200,
    fee: 5,
    entryPrice: 50_000,
    exitPrice: 52_000,
    openedAt: '2026-02-01T10:00:00.000Z',
    closedAt: '2026-02-01T12:00:00.000Z',
  }),
  aTrade({
    symbol: 'BTCUSDT',
    pnl: 150,
    fee: 5,
    entryPrice: 51_000,
    exitPrice: 52_500,
    openedAt: '2026-02-02T10:00:00.000Z',
    closedAt: '2026-02-02T12:00:00.000Z',
  }),
  aTrade({
    symbol: 'ETHUSDT',
    pnl: -100,
    fee: 5,
    entryPrice: 3_000,
    exitPrice: 2_900,
    openedAt: '2026-02-03T10:00:00.000Z',
    closedAt: '2026-02-03T12:00:00.000Z',
  }),
  aTrade({
    symbol: 'ETHUSDT',
    pnl: 80,
    fee: 5,
    entryPrice: 2_900,
    exitPrice: 2_980,
    openedAt: '2026-02-04T10:00:00.000Z',
    closedAt: '2026-02-04T12:00:00.000Z',
  }),
  aTrade({
    symbol: 'XAUUSD',
    side: 'sell',
    pnl: -200,
    fee: 5,
    entryPrice: 2_300,
    exitPrice: 2_320,
    openedAt: '2026-02-05T10:00:00.000Z',
    closedAt: '2026-02-05T12:00:00.000Z',
  }),
];

/** The arithmetic above, as numbers a test can assert against. */
export const KNOWN_STATS = {
  count: 5,
  wins: 3,
  losses: 2,
  winRate: 60,
  grossProfit: 415,
  grossLoss: 310,
  netTotal: 105,
  profitFactor: 415 / 310,
  bySymbol: {
    BTCUSDT: { trades: 2, net: 340 },
    ETHUSDT: { trades: 2, net: -30 },
    XAUUSD: { trades: 1, net: -205 },
  },
} as const;

export const netPnl = (trade: Trade): number => (trade.pnl ?? 0) - (trade.fee ?? 0);
