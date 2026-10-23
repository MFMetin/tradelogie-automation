import { test, expect } from '../../src/fixtures/base';
import { body, errorOf, newApiContext } from '../../src/api/client';
import * as trades from '../../src/api/trades';
import type { Trade } from '../../src/api/trades';
import { createPremiumUser } from '../../src/fixtures/users';
import { aTrade, clearTrades } from '../../src/fixtures/data';

/**
 * The account is worker-scoped, so the tests in this file share a journal.
 * Anything that asserts on a whole listing has to start from an empty one, and
 * tests within a worker run one at a time, so clearing here is enough.
 */
test.beforeEach(async ({ userApi }) => {
  await clearTrades(userApi);
});

test.describe('POST /trades validation', () => {
  test('requires a symbol', async ({ userApi }) => {
    const response = await trades.createTrade(userApi, {
      ...aTrade(),
      symbol: '',
    });
    expect(response.status()).toBe(400);
  });

  test('uppercases and trims the symbol', async ({ userApi }) => {
    const created = await body<Trade>(
      await trades.createTrade(userApi, { ...aTrade(), symbol: '  ethusdt  ' }),
    );
    expect(created.symbol).toBe('ETHUSDT');
  });

  test('answers 400 for a comma decimal, not 500', async ({ userApi }) => {
    // This used to hand the request body to Prisma untouched, so a price sent
    // as "1,25" became a bare 500 and the caller learned nothing about why.
    const response = await trades.createTrade(userApi, {
      ...aTrade(),
      entryPrice: '1,25',
    });
    expect(response.status()).toBe(400);
    expect((await errorOf(response)).message).toBeTruthy();
  });

  test('refuses to write a column the caller invented', async ({ userApi }) => {
    const created = await body<Trade & Record<string, unknown>>(
      await trades.createTrade(userApi, { ...aTrade(), xp: 999_999, role: 'admin' }),
    );
    // Dropped by the schema rather than merely unused afterwards: anything the
    // caller cared to name used to be writable.
    expect(created.xp).toBeUndefined();
    expect(created.role).toBeUndefined();
  });

  test('defaults the fee to zero and keeps it a positive cost', async ({ userApi }) => {
    const created = await body<Trade>(
      await trades.createTrade(userApi, { ...aTrade(), fee: undefined }),
    );
    expect(created.fee).toBe(0);
  });

  test('stores an open trade with no exit', async ({ userApi }) => {
    const created = await body<Trade>(
      await trades.createTrade(userApi, {
        ...aTrade(),
        status: 'open',
        exitPrice: undefined,
        closedAt: undefined,
        pnl: undefined,
      }),
    );
    expect(created.status).toBe('open');
    expect(created.exitPrice).toBeNull();
    expect(created.closedAt).toBeNull();
  });

  test('round-trips every field it accepts', async ({ userApi }) => {
    const input = aTrade({
      symbol: 'XAUUSD',
      side: 'sell',
      entryPrice: 2350.5,
      exitPrice: 2340.25,
      size: 1.5,
      pnl: 153.75,
      fee: 3.5,
      stopLoss: 2360,
      takeProfit: 2330,
      notes: 'Short into the London open.',
      tags: ['gold', 'london'],
    });

    const created = await body<Trade>(await trades.createTrade(userApi, input));
    expect(created).toMatchObject({
      symbol: 'XAUUSD',
      side: 'sell',
      status: 'closed',
      entryPrice: 2350.5,
      exitPrice: 2340.25,
      size: 1.5,
      pnl: 153.75,
      fee: 3.5,
      stopLoss: 2360,
      takeProfit: 2330,
      notes: 'Short into the London open.',
    });
    expect(created.tags).toEqual(['gold', 'london']);
    expect(created.id).toBeTruthy();
    expect(new Date(created.openedAt!).toISOString()).toBe(created.openedAt);
  });
});

test.describe('PUT /trades/:id', () => {
  test('applies a partial edit and leaves the rest alone', async ({ userApi }) => {
    const created = await body<Trade>(
      await trades.createTrade(userApi, aTrade({ symbol: 'SOLUSDT', notes: 'first' })),
    );

    const updated = await body<Trade>(
      await trades.updateTrade(userApi, created.id, { notes: 'second' }),
    );
    expect(updated.notes).toBe('second');
    expect(updated.symbol).toBe('SOLUSDT');
    expect(updated.entryPrice).toBe(created.entryPrice);
  });

  test('cannot reassign a trade to another user', async ({ userApi, adminApi }) => {
    const created = await body<Trade>(await trades.createTrade(userApi, aTrade()));
    const stranger = await createPremiumUser('thief');

    // `userId` is not one of the schema's keys, so the attempt is dropped
    // rather than deleted after the fact.
    const updated = await body<Trade>(
      await trades.updateTrade(userApi, created.id, { userId: stranger.id, notes: 'moved' }),
    );
    expect(updated.userId).toBe(created.userId);
    expect(updated.notes).toBe('moved');

    // And the stranger still cannot see it.
    const asStranger = await newApiContext(stranger.accessToken);
    try {
      expect((await trades.getTrade(asStranger, created.id)).ok()).toBeFalsy();
    } finally {
      await asStranger.dispose();
    }
    expect(adminApi).toBeTruthy();
  });
});

test.describe('ownership', () => {
  test('one user cannot read, edit or delete another user’s trade', async ({ userApi }) => {
    const mine = await body<Trade>(await trades.createTrade(userApi, aTrade()));
    const stranger = await createPremiumUser('nosy');
    const asStranger = await newApiContext(stranger.accessToken);

    try {
      expect((await trades.getTrade(asStranger, mine.id)).status()).toBe(403);
      expect((await trades.updateTrade(asStranger, mine.id, { notes: 'x' })).status()).toBe(403);
      expect((await trades.deleteTrade(asStranger, mine.id)).status()).toBe(403);

      // Still there, and still mine.
      expect((await trades.getTrade(userApi, mine.id)).ok()).toBeTruthy();
    } finally {
      await asStranger.dispose();
    }
  });

  test('a listing only ever contains the caller’s own trades', async ({ userApi }) => {
    const stranger = await createPremiumUser('other');
    const asStranger = await newApiContext(stranger.accessToken);

    try {
      await trades.createTrade(userApi, aTrade({ symbol: 'MINEUSDT' }));
      await trades.createTrade(asStranger, aTrade({ symbol: 'THEIRSUSDT' }));

      const theirs = await trades.allTrades(asStranger);
      expect(theirs.map((trade) => trade.symbol)).not.toContain('MINEUSDT');
      expect(theirs.every((trade) => trade.userId === stranger.id)).toBe(true);
    } finally {
      await asStranger.dispose();
    }
  });
});

test.describe('POST /trades/bulk', () => {
  test('reports each bad row by index instead of failing the batch', async ({ userApi }) => {
    const rows = [
      aTrade({ symbol: 'AAAUSDT' }),
      { ...aTrade({ symbol: 'BBBUSDT' }), entryPrice: 'not-a-number' },
      aTrade({ symbol: 'CCCUSDT' }),
    ];

    const result = await body<trades.BulkResult>(await trades.bulkImport(userApi, rows));
    expect(result.imported).toBe(2);
    expect(result.failed).toHaveLength(1);
    // The index is what lets the wizard point at the offending line of the CSV.
    expect(result.failed[0]?.row).toBe(1);
    expect(result.failed[0]?.message).toBeTruthy();

    const symbols = (await trades.allTrades(userApi)).map((trade) => trade.symbol);
    expect(symbols).toContain('AAAUSDT');
    expect(symbols).toContain('CCCUSDT');
    expect(symbols).not.toContain('BBBUSDT');
  });

  test('deduplicates on sourceTradeId server-side', async ({ userApi }) => {
    const rows = [
      aTrade({ symbol: 'DUPUSDT', sourceTradeId: 'exness-csv-10001' }),
      aTrade({ symbol: 'DUPUSDT', sourceTradeId: 'exness-csv-10002' }),
    ];

    const first = await body<trades.BulkResult>(await trades.bulkImport(userApi, rows));
    expect(first.imported).toBe(2);
    expect(first.skippedDuplicates).toBe(0);

    // The wizard also dedupes against the loaded list before it posts, but the
    // server is the half that survives two tabs importing the same file.
    const second = await body<trades.BulkResult>(await trades.bulkImport(userApi, rows));
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(2);
  });

  test('stamps the import metadata it is given', async ({ userApi }) => {
    const batch = `batch-${Date.now()}`;
    await trades.bulkImport(userApi, [
      aTrade({
        symbol: 'METAUSDT',
        sourcePlatform: 'exness',
        sourceTradeId: 'exness-csv-777',
        importMethod: 'csvImport',
        importBatchId: batch,
      }),
    ]);

    const stored = (await trades.allTrades(userApi)).find(
      (trade) => trade.symbol === 'METAUSDT',
    );
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      sourcePlatform: 'exness',
      importMethod: 'csvImport',
      importBatchId: batch,
    });
    // No connected account, which is why the journal needs a CSV bucket of its
    // own in the account filter.
    expect(stored?.sourceAccountId).toBeNull();
  });
});

test.describe('POST /trades/bulk-delete', () => {
  test('removes a selection by id', async ({ userApi }) => {
    const a = await body<Trade>(await trades.createTrade(userApi, aTrade({ symbol: 'DELAUSDT' })));
    const b = await body<Trade>(await trades.createTrade(userApi, aTrade({ symbol: 'DELBUSDT' })));
    const keep = await body<Trade>(
      await trades.createTrade(userApi, aTrade({ symbol: 'KEEPUSDT' })),
    );

    expect((await trades.bulkDelete(userApi, { ids: [a.id, b.id] })).ok()).toBeTruthy();

    const symbols = (await trades.allTrades(userApi)).map((trade) => trade.symbol);
    expect(symbols).not.toContain('DELAUSDT');
    expect(symbols).not.toContain('DELBUSDT');
    expect(symbols).toContain('KEEPUSDT');
    expect(keep.id).toBeTruthy();
  });

  test('undoes a whole import by batch id', async ({ userApi }) => {
    const batch = `undo-${Date.now()}`;
    await trades.bulkImport(userApi, [
      aTrade({ symbol: 'UNDOAUSDT', sourceTradeId: `${batch}-1`, importBatchId: batch }),
      aTrade({ symbol: 'UNDOBUSDT', sourceTradeId: `${batch}-2`, importBatchId: batch }),
    ]);
    await trades.createTrade(userApi, aTrade({ symbol: 'MANUALUSDT' }));

    expect((await trades.bulkDelete(userApi, { importBatchId: batch })).ok()).toBeTruthy();

    const symbols = (await trades.allTrades(userApi)).map((trade) => trade.symbol);
    expect(symbols).not.toContain('UNDOAUSDT');
    expect(symbols).not.toContain('UNDOBUSDT');
    expect(symbols).toContain('MANUALUSDT');
  });

  test('refuses an empty id list', async ({ userApi }) => {
    expect((await trades.bulkDelete(userApi, { ids: [] })).status()).toBe(400);
  });

  test('cannot delete another user’s trades through a bulk call', async ({ userApi }) => {
    const mine = await body<Trade>(await trades.createTrade(userApi, aTrade({ symbol: 'SAFEUSDT' })));
    const stranger = await createPremiumUser('bulkthief');
    const asStranger = await newApiContext(stranger.accessToken);

    try {
      // Whether it 403s or silently deletes nothing, the row must survive. A
      // bulk endpoint that filtered by id alone would be a way to wipe anyone.
      await trades.bulkDelete(asStranger, { ids: [mine.id] });
      expect((await trades.getTrade(userApi, mine.id)).ok()).toBeTruthy();
    } finally {
      await asStranger.dispose();
    }
  });
});

test.describe('GET /trades', () => {
  test('pages with limit and offset, newest open first', async ({ userApi }) => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    for (let index = 0; index < 5; index += 1) {
      await trades.createTrade(
        userApi,
        aTrade({
          symbol: `PAGE${index}USDT`,
          openedAt: new Date(base + index * 86_400_000).toISOString(),
        }),
      );
    }

    const firstPage = await body<Trade[]>(await trades.listTrades(userApi, { limit: 2 }));
    expect(firstPage).toHaveLength(2);
    // Ordered by openedAt desc, so the latest day comes first.
    expect(firstPage[0]?.symbol).toBe('PAGE4USDT');
    expect(firstPage[1]?.symbol).toBe('PAGE3USDT');

    const secondPage = await body<Trade[]>(
      await trades.listTrades(userApi, { limit: 2, offset: 2 }),
    );
    expect(secondPage.map((trade) => trade.symbol)).toEqual(['PAGE2USDT', 'PAGE1USDT']);
  });
});
