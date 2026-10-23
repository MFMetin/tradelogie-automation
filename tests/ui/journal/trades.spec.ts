import { test, expect } from '../../../src/fixtures/base';
import { JournalPage } from '../../../src/pages/JournalPage';
import { t } from '../../../src/utils/i18n';
import { aTrade, clearTrades, netPnl } from '../../../src/fixtures/data';
import { seedTrades, allTrades } from '../../../src/api/trades';

test.beforeEach(async ({ userApi }) => {
  await clearTrades(userApi);
});

test.describe('logging a trade', () => {
  test('a trade entered in the form shows up with the right net P&L', async ({
    authedPage,
    userApi,
  }) => {
    const journal = new JournalPage(authedPage);
    await journal.open();

    const form = await journal.openCreateForm();
    await form.save({
      symbol: 'SOLUSDT',
      side: 'buy',
      status: 'closed',
      entryPrice: '150',
      exitPrice: '165',
      size: '10',
      pnl: '150',
      fee: '7.5',
      openedAt: '2026-03-01T09:00',
      closedAt: '2026-03-01T15:00',
    });

    await expect(journal.row('SOLUSDT')).toBeVisible();
    // `netPnl = pnl - fee`, and the fee is stored as a positive cost. 150 - 7.5.
    await expect(journal.row('SOLUSDT')).toContainText('142.5');

    const stored = (await allTrades(userApi)).find((trade) => trade.symbol === 'SOLUSDT');
    expect(stored).toBeDefined();
    expect(stored!.fee).toBe(7.5);
    expect(netPnl(stored!)).toBeCloseTo(142.5, 2);
  });

  test('the side and status toggles report which one is chosen', async ({ authedPage }) => {
    const journal = new JournalPage(authedPage);
    await journal.open();
    const form = await journal.openCreateForm();

    // `closed` is the form's default, and `buy` the default side.
    await expect(form.sideButton('buy')).toHaveAttribute('aria-pressed', 'true');
    await expect(form.sideButton('sell')).toHaveAttribute('aria-pressed', 'false');
    await expect(form.statusButton('closed')).toHaveAttribute('aria-pressed', 'true');

    await form.sideButton('sell').click();
    await expect(form.sideButton('sell')).toHaveAttribute('aria-pressed', 'true');
    await expect(form.sideButton('buy')).toHaveAttribute('aria-pressed', 'false');

    // This is a regression test for an invisible defect: the selection used to
    // live only in a Tailwind class, so a screen reader read two identical
    // buttons and no test could tell which was active without matching CSS.
  });

  test('an open trade disables the fields that only a close has', async ({ authedPage }) => {
    const journal = new JournalPage(authedPage);
    await journal.open();
    const form = await journal.openCreateForm();

    await form.statusButton('open').click();

    await expect(form.exitPrice).toBeDisabled();
    await expect(form.closedAt).toBeDisabled();
  });

  test('the dialog is named by its own heading', async ({ authedPage }) => {
    const journal = new JournalPage(authedPage);
    await journal.open();
    await journal.addTradeButton.click();

    // `getByRole('dialog', { name })` only resolves because the modal points
    // `aria-labelledby` at its heading. It announced itself as an unnamed
    // "dialog" before, and the trigger button and the heading are the same
    // string in both languages — so there was nothing to disambiguate with.
    await expect(
      authedPage.getByRole('dialog', { name: t('tf.logTitle') }),
    ).toBeVisible();
  });

  test('escape closes the dialog without saving', async ({ authedPage }) => {
    const journal = new JournalPage(authedPage);
    await journal.open();
    const form = await journal.openCreateForm();
    await form.symbol.fill('GHOSTUSDT');

    await authedPage.keyboard.press('Escape');

    await expect(form.root).toBeHidden();
    await expect(journal.row('GHOSTUSDT')).toHaveCount(0);
  });
});

test.describe('editing and deleting', () => {
  test('an edit is saved and shown', async ({ authedPage, userApi }) => {
    await seedTrades(userApi, [aTrade({ symbol: 'EDITUSDT', notes: 'before' })]);

    const journal = new JournalPage(authedPage);
    await journal.open();

    const form = await journal.openEditForm('EDITUSDT');
    await expect(form.symbol).toHaveValue('EDITUSDT');
    await form.save({ symbol: 'EDITEDUSDT', notes: 'after' });

    await expect(journal.row('EDITEDUSDT')).toBeVisible();
    await expect(journal.row('EDITUSDT')).toHaveCount(0);

    const stored = await allTrades(userApi);
    expect(stored.map((trade) => trade.symbol)).toEqual(['EDITEDUSDT']);
    expect(stored[0]?.notes).toBe('after');
  });

  test('a delete asks first, then removes the trade', async ({ authedPage, userApi }) => {
    await seedTrades(userApi, [
      aTrade({ symbol: 'GONEUSDT' }),
      aTrade({ symbol: 'STAYSUSDT', openedAt: '2026-01-16T10:00:00.000Z' }),
    ]);

    const journal = new JournalPage(authedPage);
    await journal.open();
    await expect(journal.rows).toHaveCount(2);

    await journal.deleteTrade('GONEUSDT');

    await expect(journal.row('GONEUSDT')).toHaveCount(0);
    await expect(journal.row('STAYSUSDT')).toBeVisible();
    expect((await allTrades(userApi)).map((trade) => trade.symbol)).toEqual(['STAYSUSDT']);
  });
});

test.describe('filtering', () => {
  test('search narrows by symbol', async ({ authedPage, userApi }) => {
    await seedTrades(userApi, [
      aTrade({ symbol: 'BTCUSDT' }),
      aTrade({ symbol: 'ETHUSDT', openedAt: '2026-01-16T10:00:00.000Z' }),
      aTrade({ symbol: 'XAUUSD', openedAt: '2026-01-17T10:00:00.000Z' }),
    ]);

    const journal = new JournalPage(authedPage);
    await journal.open();
    await expect(journal.rows).toHaveCount(3);

    await journal.search.fill('eth');

    await expect(journal.rows).toHaveCount(1);
    await expect(journal.row('ETHUSDT')).toBeVisible();
  });

  test('the account filter keeps CSV imports in a bucket of their own', async ({
    authedPage,
    userApi,
  }) => {
    // A CSV row has a broker but no `sourceAccountId`, so without its own
    // bucket in `matchesScope` it matches neither "Manual" nor any connected
    // account and shows up only under "All accounts". That is what CSV_SCOPE
    // exists for, and this is the test that would notice it going away.
    await seedTrades(userApi, [
      aTrade({ symbol: 'MANUALUSDT' }),
      aTrade({
        symbol: 'IMPORTEDUSDT',
        openedAt: '2026-01-16T10:00:00.000Z',
        sourcePlatform: 'exness',
        importMethod: 'csvImport',
        sourceTradeId: 'exness-csv-4242',
      }),
    ]);

    const journal = new JournalPage(authedPage);
    await journal.open();
    await expect(journal.rows).toHaveCount(2);

    // The manual row says so in its account column; the imported one names
    // the broker it came from instead. `platformLabel` maps `exness` to
    // "MetaTrader 5" — the id is the venue, the label is the platform people
    // recognise, and the filter shows the label.
    await expect(journal.row('MANUALUSDT')).toContainText(t('jr.manual'));
    await expect(journal.row('IMPORTEDUSDT')).toContainText('MetaTrader 5');

    // Below `lg` the filter row is behind a disclosure, so a test that went
    // straight for the select found nothing and reported a missing control
    // rather than a closed panel.
    await journal.revealFilters();

    const options = await journal.accountFilter.locator('option').allTextContents();
    // "All", "Manual", and a bucket for the CSV broker.
    expect(options).toContain(t('jr.manual'));
    expect(options).toContain('MetaTrader 5');

    // And the bucket actually filters, which is the part that regressed before:
    // a CSV row has no `sourceAccountId`, so without CSV_SCOPE it belonged to
    // neither "Manual" nor any account and only ever appeared under "All".
    await journal.accountFilter.selectOption({ label: 'MetaTrader 5' });
    await expect(journal.rows).toHaveCount(1);
    await expect(journal.row('IMPORTEDUSDT')).toBeVisible();

    await journal.accountFilter.selectOption({ label: t('jr.manual') });
    await expect(journal.rows).toHaveCount(1);
    await expect(journal.row('MANUALUSDT')).toBeVisible();
  });
});

test.describe('the phone layout', () => {
  test('edit and delete are reachable on a card @mobile-only', async ({ authedPage, userApi }) => {
    test.skip(
      (authedPage.viewportSize()?.width ?? 0) > 640,
      'this is about the card layout, which only renders below lg',
    );

    await seedTrades(userApi, [aTrade({ symbol: 'PHONEUSDT' })]);

    const journal = new JournalPage(authedPage);
    await journal.open();

    // The table's action buttons were inside a horizontal scroller and
    // `opacity-0` until hover, neither of which a phone has. The card layout
    // exists so these two are real, tappable controls.
    await expect(journal.rowAction('PHONEUSDT', 'edit')).toBeVisible();
    await expect(journal.rowAction('PHONEUSDT', 'delete')).toBeVisible();

    const box = await journal.rowAction('PHONEUSDT', 'edit').boundingBox();
    // 44px is the usual floor for a touch target; the card actions are min-h-11.
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
  });

  test('the nav is behind a menu button @mobile-only', async ({ authedPage }) => {
    test.skip(
      (authedPage.viewportSize()?.width ?? 0) > 1024,
      'the drawer only exists below lg',
    );

    const journal = new JournalPage(authedPage);
    await journal.open();

    await expect(journal.shell.mobileMenuButton).toBeVisible();
    await journal.shell.mobileMenuButton.click();

    const drawer = journal.shell.mobileDrawer;
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('a[href="/analytics"]')).toBeVisible();
  });
});
