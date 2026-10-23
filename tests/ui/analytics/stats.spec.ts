import { test, expect, type TestUser } from '../../../src/fixtures/base';
import type { Page } from '@playwright/test';
import { t, format } from '../../../src/utils/i18n';
import { KNOWN_SET, KNOWN_STATS, clearTrades } from '../../../src/fixtures/data';
import { bulkImport } from '../../../src/api/trades';
import { newApiContext } from '../../../src/api/client';

/**
 * The deterministic oracle, and the most valuable test in the suite.
 *
 * There is no analytics endpoint. Everything on this page — the equity curve,
 * win rate, profit factor, the by-symbol table — is computed in the browser by
 * `lib/analytics.ts` from whatever `/trades` returned. So a fixed set of trades
 * has exactly one correct set of statistics, and they can be worked out by hand
 * once (in `fixtures/data.ts`) instead of by running the code under test.
 *
 * That is the difference between this and the usual "assert the page shows a
 * number" test: a second implementation of the same arithmetic agrees with the
 * first one's bugs. A hand-checked table does not.
 *
 *   +200-5 = +195   BTCUSDT  win      wins 3, losses 2      -> 60%
 *   +150-5 = +145   BTCUSDT  win      gross profit 415
 *   -100-5 = -105   ETHUSDT  loss     gross loss    310
 *    +80-5 =  +75   ETHUSDT  win      profit factor 1.34
 *   -200-5 = -205   XAUUSD   loss     net           +105
 */

/** The value inside a `StatCard`, found by the label it is grouped under. */
function stat(page: Page, label: string) {
  // `role="group"` + `aria-labelledby` is what makes this possible. The three
  // paragraphs in the card had nothing tying them together before, so reading
  // a figure meant matching a Tailwind class or counting siblings.
  return page.getByRole('group', { name: label });
}

async function seedKnownSet(user: TestUser): Promise<void> {
  const api = await newApiContext(user.accessToken);
  try {
    await clearTrades(api);
    // One bulk call: five creates is five round trips for no reason, and the
    // bulk path validates with the same schema.
    const response = await bulkImport(api, KNOWN_SET);
    if (!response.ok()) {
      throw new Error(`Seeding the known set failed: ${await response.text()}`);
    }
  } finally {
    await api.dispose();
  }
}

test.describe('analytics, against a hand-computed set', () => {
  test.beforeEach(async ({ premiumUser }) => {
    await seedKnownSet(premiumUser);
  });

  test('every headline figure matches the arithmetic', async ({ authedPage }) => {
    await authedPage.goto('/analytics');
    await expect(authedPage.getByText(t('eb.title'))).toHaveCount(0);

    // `fmtCurrency` writes "$105.00"; net is total P&L minus fees, which is
    // what the journal shows per row too.
    await expect(stat(authedPage, t('dash.netPnl'))).toContainText('$105.00');

    // `fmtPercent` writes one decimal: 3 of 5 closed.
    await expect(stat(authedPage, t('dash.winRate'))).toContainText('60.0%');
    await expect(stat(authedPage, t('dash.winRate'))).toContainText(
      format('dash.winLossShort', { wins: KNOWN_STATS.wins, losses: KNOWN_STATS.losses }),
    );

    // 415 / 310 = 1.3387..., rendered with `toFixed(2)`.
    await expect(stat(authedPage, t('dash.profitFactor'))).toContainText(
      KNOWN_STATS.profitFactor.toFixed(2),
    );
    expect(KNOWN_STATS.profitFactor.toFixed(2)).toBe('1.34');

    // Expectancy is the net divided by the number of closed trades: 105 / 5.
    await expect(stat(authedPage, t('an.expectancy'))).toContainText('$21.00');
  });

  test('the secondary metrics match too', async ({ authedPage }) => {
    await authedPage.goto('/analytics');

    await expect(authedPage.getByText(t('an.totalTrades'))).toBeVisible();

    const panel = authedPage.locator('main');
    await expect(panel).toContainText(String(KNOWN_STATS.count));
    // Best and worst are net of fees: +195 and -205.
    await expect(panel).toContainText('$195.00');
    await expect(panel).toContainText('-$205.00');
    // Five trades at $5 each.
    await expect(panel).toContainText('$25.00');
  });

  test('a losing set is reported as losing, not as an absolute value', async ({
    authedPage,
    premiumUser,
  }) => {
    // The sign is easy to lose: `avgLoss` is stored positive and negated at the
    // point of display, and `fmtCurrency` adds its own sign. Feeding a set that
    // nets a loss is the cheapest way to check the whole chain agrees.
    const api = await newApiContext(premiumUser.accessToken);
    try {
      await clearTrades(api);
      await bulkImport(api, [
        { ...KNOWN_SET[2]!, sourceTradeId: 'oracle-loss-1' },
        { ...KNOWN_SET[4]!, sourceTradeId: 'oracle-loss-2' },
      ]);
    } finally {
      await api.dispose();
    }

    await authedPage.goto('/analytics');

    // -105 + -205
    await expect(stat(authedPage, t('dash.netPnl'))).toContainText('-$310.00');
    await expect(stat(authedPage, t('dash.winRate'))).toContainText('0.0%');
    // No gross profit at all, so the ratio is 0 rather than infinite.
    await expect(stat(authedPage, t('dash.profitFactor'))).toContainText('0');
  });

  test('an all-winning set reports an infinite profit factor', async ({
    authedPage,
    premiumUser,
  }) => {
    const api = await newApiContext(premiumUser.accessToken);
    try {
      await clearTrades(api);
      await bulkImport(api, [
        { ...KNOWN_SET[0]!, sourceTradeId: 'oracle-win-1' },
        { ...KNOWN_SET[1]!, sourceTradeId: 'oracle-win-2' },
      ]);
    } finally {
      await api.dispose();
    }

    await authedPage.goto('/analytics');

    // grossLoss is 0, so the division is guarded: the page shows ∞ rather than
    // "Infinity" or "NaN", both of which this has rendered in the past.
    await expect(stat(authedPage, t('dash.profitFactor'))).toContainText('∞');
    await expect(stat(authedPage, t('dash.winRate'))).toContainText('100.0%');
  });

  test('the dashboard agrees with the analytics page', async ({ authedPage }) => {
    // Both read the same `computeStats`, so disagreement would mean one of them
    // is filtering or scoping differently — which is exactly the kind of thing
    // that goes unnoticed.
    await authedPage.goto('/analytics');
    const fromAnalytics = await stat(authedPage, t('dash.netPnl')).textContent();

    await authedPage.goto('/dashboard');
    const fromDashboard = await stat(authedPage, t('dash.netPnl')).textContent();

    expect(fromDashboard).toContain('$105.00');
    expect(fromAnalytics).toContain('$105.00');
  });
});
