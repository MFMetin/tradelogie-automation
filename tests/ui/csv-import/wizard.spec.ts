import type { Page } from '@playwright/test';
import { test, expect } from '../../../src/fixtures/base';
import { JournalPage } from '../../../src/pages/JournalPage';
import { ImportWizard } from '../../../src/pages/ImportWizard';
import { clearTrades, netPnl } from '../../../src/fixtures/data';
import { allTrades } from '../../../src/api/trades';
import { t } from '../../../src/utils/i18n';

test.beforeEach(async ({ userApi }) => {
  await clearTrades(userApi);
});

async function openWizard(page: Page): Promise<ImportWizard> {
  const journal = new JournalPage(page);
  await journal.open();
  await journal.importCsvButton.click();
  const wizard = new ImportWizard(page);
  await wizard.open();
  return wizard;
}

/**
 * `columnGuess` reads the headers and gets symbol, side and size from this
 * file's names. The rest it cannot infer — "Open Rate" is not a phrase it
 * knows — and that is the whole point of the mapping step. Listed in full so
 * the test says what the app guessed and what a person has to finish.
 */
const UNKNOWN_BROKER_MAPPING: Record<string, string> = {
  symbol: 'Instrument',
  side: 'Direction',
  size: 'Qty',
  entryPrice: 'Open Rate',
  openedAt: 'Opened (UTC)',
  exitPrice: 'Close Rate',
  closedAt: 'Closed (UTC)',
  pnl: 'Realised',
  fee: 'Charges',
};

async function mapUnknownBroker(wizard: ImportWizard): Promise<void> {
  for (const [field, header] of Object.entries(UNKNOWN_BROKER_MAPPING)) {
    await wizard.columnSelect(field).selectOption(header);
  }
}

test.describe('a recognised broker export', () => {
  test('is detected, previewed and imported', async ({ authedPage, userApi }) => {
    const wizard = await openWizard(authedPage);
    await wizard.choose('mt5-20-trades.csv');

    // The preset matches on normalised headers, so a file that renamed one
    // column still resolves. A miss here would quietly turn this into a test
    // of the column-guessing fallback instead.
    await expect(wizard.detectedBadge('MetaTrader 5')).toBeVisible();

    await expect(wizard.nextButton).toBeEnabled();
    await wizard.toPreview();
    await wizard.runImport();

    await wizard.expectImported(20);
    expect(await allTrades(userApi)).toHaveLength(20);
  });

  test('stores the fee as a positive cost, whatever sign the broker used', async ({
    authedPage,
    userApi,
  }) => {
    const wizard = await openWizard(authedPage);
    await wizard.choose('mt5-20-trades.csv');
    await wizard.toPreview();
    await wizard.runImport();
    await wizard.expectImported(20);

    const stored = await allTrades(userApi);
    // MT5 exports commission as a NEGATIVE debit (-1.20 in the fixture). The
    // importer takes its absolute value, because `netPnl = pnl - fee` treats
    // the fee as a cost — left signed, it would be ADDED to the result.
    for (const trade of stored) {
      expect(trade.fee, `${trade.symbol} fee`).toBe(1.2);
    }
    const long = stored.find((trade) => trade.side === 'buy');
    expect(long).toBeDefined();
    expect(netPnl(long!)).toBeCloseTo(12 - 1.2, 2);
  });

  test('stamps the broker and one import batch on every row', async ({
    authedPage,
    userApi,
  }) => {
    const wizard = await openWizard(authedPage);
    await wizard.choose('mt5-20-trades.csv');
    await wizard.toPreview();
    await wizard.runImport();
    await wizard.expectImported(20);

    const stored = await allTrades(userApi);
    for (const trade of stored) {
      expect(trade.importMethod).toBe('csvImport');
      expect(trade.sourcePlatform).toBe('exness');
      // `{platform}-csv-{ticket}` from the Position column, which is what lets
      // a re-import of the same file recognise itself.
      expect(trade.sourceTradeId).toMatch(/^exness-csv-\d+$/);
      // No connected account — the reason the journal needs a CSV bucket.
      expect(trade.sourceAccountId).toBeNull();
    }
    const batches = new Set(stored.map((trade) => trade.importBatchId));
    expect(batches.size, 'one import is one batch, so it can be undone').toBe(1);
  });

  test('a re-import of the same file cannot even be submitted', async ({
    authedPage,
    userApi,
  }) => {
    const first = await openWizard(authedPage);
    await first.choose('mt5-20-trades.csv');
    await first.toPreview();
    await first.runImport();
    await first.expectImported(20);
    await authedPage.keyboard.press('Escape');

    const second = await openWizard(authedPage);
    await second.choose('mt5-20-trades.csv');
    await second.toPreview();

    // Deduping happens twice: here in the wizard against the already-loaded
    // trade list (instant, no request) and again server-side against the DB.
    // The client half recognises all twenty, so the button reads "Import 0
    // trades" and is DISABLED — a no-op import cannot even be sent, which is
    // better than sending it and being told nothing happened.
    await expect(second.importButton).toBeDisabled();
    await expect(second.importButton).toHaveText(/\b0\b/);

    expect(await allTrades(userApi)).toHaveLength(20);

    // The server-side half has its own test, at the API layer, where two tabs
    // posting the same file at once can actually be expressed:
    // tests/api/trades.spec.ts — "deduplicates on sourceTradeId server-side".
  });
});

test.describe('a file no preset recognises', () => {
  test('falls back to column guessing and can be mapped by hand', async ({
    authedPage,
    userApi,
  }) => {
    // The case the whole wizard is built for. A preset is a shortcut, never a
    // requirement.
    const wizard = await openWizard(authedPage);
    await wizard.choose('unknown-broker.csv');

    await expect(wizard.detectedBadge('MetaTrader 5')).toHaveCount(0);

    // What `columnGuess` managed from the headers alone.
    await expect(wizard.columnSelect('symbol')).toHaveValue('Instrument');
    await expect(wizard.columnSelect('side')).toHaveValue('Direction');
    await expect(wizard.columnSelect('size')).toHaveValue('Qty');
    // And what it could not: `openedAt` is required, so Continue is shut until
    // someone maps it.
    await expect(wizard.columnSelect('openedAt')).toHaveValue('');
    await expect(wizard.nextButton).toBeDisabled();

    await mapUnknownBroker(wizard);

    await expect(wizard.nextButton).toBeEnabled();
    await wizard.toPreview();
    await wizard.runImport();

    await wizard.expectImported(3);

    const stored = await allTrades(userApi);
    expect(stored.map((trade) => trade.symbol).sort()).toEqual(['AAPL', 'MSFT', 'NVDA']);
    // LONG/SHORT is resolved to buy/sell — `resolveSide` knows both spellings.
    expect(stored.find((trade) => trade.symbol === 'MSFT')?.side).toBe('sell');
    expect(stored.find((trade) => trade.symbol === 'AAPL')?.side).toBe('buy');
    // With no ticket column the importer builds a deterministic key from the
    // trade's own facts, so a re-import still recognises itself.
    for (const trade of stored) expect(trade.sourceTradeId).toBeTruthy();
  });

  test('Continue goes dark again if a required field is unmapped', async ({ authedPage }) => {
    const wizard = await openWizard(authedPage);
    await wizard.choose('unknown-broker.csv');
    await mapUnknownBroker(wizard);
    await expect(wizard.nextButton).toBeEnabled();

    // Symbol is the one field nothing can be inferred without.
    await wizard.columnSelect('symbol').selectOption('');
    await expect(wizard.nextButton).toBeDisabled();

    await wizard.columnSelect('symbol').selectOption('Instrument');
    await expect(wizard.nextButton).toBeEnabled();
  });
});

test.describe('bad rows', () => {
  test('are rejected individually while the good ones land', async ({
    authedPage,
    userApi,
  }) => {
    const wizard = await openWizard(authedPage);
    await wizard.choose('mt5-malformed.csv');
    await wizard.toPreview();
    await wizard.runImport();

    // Two good rows, three bad. Whether a row is caught in the browser by
    // `normalizeRow` or server-side by the bulk schema, the batch is not lost
    // over it — which is what matters for a 2000-row export with one typo.
    await expect(wizard.resultTitle).toBeVisible({ timeout: 60_000 });
    await expect(wizard.imported(2)).toBeVisible();

    const stored = await allTrades(userApi);
    expect(stored).toHaveLength(2);
    for (const trade of stored) {
      expect(trade.symbol).toBeTruthy();
      expect(Number.isFinite(trade.entryPrice)).toBe(true);
      expect(trade.openedAt).toBeTruthy();
    }
  });
});

test.describe('chunking', () => {
  test('a 601-row file is posted as two chunks of at most 500', async ({
    authedPage,
    userApi,
  }) => {
    const bulkPosts: number[] = [];
    authedPage.on('request', (request) => {
      if (request.method() === 'POST' && /\/trades\/bulk$/.test(request.url())) {
        const body = request.postDataJSON() as { trades?: unknown[] } | null;
        bulkPosts.push(body?.trades?.length ?? 0);
      }
    });

    const wizard = await openWizard(authedPage);
    await wizard.choose('mt5-601-trades.csv');
    await wizard.toPreview();
    await wizard.runImport();

    await wizard.expectImported(601, 120_000);

    // Two requests, 500 + 101. The endpoint accepts up to 5000, so the chunking
    // is the client's own choice: it keeps one failure from costing the whole
    // file, and keeps each request inside the 5mb body limit.
    expect(bulkPosts).toEqual([500, 101]);
    expect(await allTrades(userApi)).toHaveLength(601);
  });
});

test.describe('saved mappings', () => {
  test('a mapping saved here is offered next time', async ({ authedPage }) => {
    const wizard = await openWizard(authedPage);
    await wizard.choose('unknown-broker.csv');
    await mapUnknownBroker(wizard);
    await wizard.toPreview();

    const name = `e2e-mapping-${Date.now()}`;
    await wizard.saveMappingCheckbox.check();
    await wizard.mappingNameInput.fill(name);
    await wizard.runImport();
    await wizard.expectImported(3);

    // Saved server-side via /import-profiles, and as HEADER NAMES rather than
    // column indexes — so it survives an export that gained a column.
    await authedPage.keyboard.press('Escape');
    const again = await openWizard(authedPage);
    await expect(again.root).toContainText(name);
  });
});

test.describe('closing the wizard', () => {
  test('asks before throwing away a half-finished import', async ({ authedPage }) => {
    const wizard = await openWizard(authedPage);
    await wizard.choose('mt5-20-trades.csv');

    await authedPage.keyboard.press('Escape');

    // Its own portal above the modal, so the modal's backdrop cannot swallow
    // the click meant for it. It has an accessible name now, which is how it
    // is found here.
    await expect(
      authedPage.getByRole('dialog', { name: t('csv.discardTitle') }),
    ).toBeVisible();
  });
});
