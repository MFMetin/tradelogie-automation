import { test, expect } from '../../src/fixtures/base';
import { expectNoNewViolations } from '../../src/utils/a11y';
import { JournalPage } from '../../src/pages/JournalPage';
import { ImportWizard } from '../../src/pages/ImportWizard';
import { aTrade, clearTrades } from '../../src/fixtures/data';
import { seedTrades } from '../../src/api/trades';
import { t } from '../../src/utils/i18n';

/**
 * axe-core over the screens people actually spend time on, in both themes.
 *
 * Both themes because contrast is a per-theme property and the app is dark
 * first: a token that passes on the dark surface can fail on the light one, and
 * nobody would find out by looking.
 *
 * The gate is a baseline rather than zero, for the reason `src/utils/a11y.ts`
 * explains: a suite that goes red on every pre-existing violation gets turned
 * off. New ones fail. Six entries came OFF the baseline while this was being
 * written, because the fix for "this control has no accessible name" belongs in
 * the app.
 */
const THEMES = ['dark', 'light'] as const;

test.describe('signed out', () => {
  for (const theme of THEMES) {
    test(`the landing page (${theme})`, async ({ pageAs }) => {
      const page = await pageAs(null, { theme });
      await page.goto('/');
      await expectNoNewViolations(page, `landing:${theme}`);
    });

    test(`the sign-in page (${theme})`, async ({ pageAs }) => {
      const page = await pageAs(null, { theme });
      await page.goto('/login');
      await expectNoNewViolations(page, `login:${theme}`);
    });

    test(`the sign-up page (${theme})`, async ({ pageAs }) => {
      const page = await pageAs(null, { theme });
      await page.goto('/register');
      await expectNoNewViolations(page, `register:${theme}`);
    });
  }

  test('a legal document', async ({ anonPage }) => {
    await anonPage.goto('/privacy');
    await expectNoNewViolations(anonPage, 'legal');
  });

  test('the not-found page', async ({ anonPage }) => {
    await anonPage.goto('/definitely-not-a-page');
    await expectNoNewViolations(anonPage, 'not-found');
  });
});

test.describe('signed in', () => {
  for (const theme of THEMES) {
    test(`the dashboard (${theme})`, async ({ pageAs, premiumUser }) => {
      const page = await pageAs(premiumUser, { theme });
      await page.goto('/dashboard');
      await expect(page.getByText(t('eb.title'))).toHaveCount(0);
      await expectNoNewViolations(page, `dashboard:${theme}`);
    });

    test(`the journal, with trades (${theme})`, async ({ pageAs, premiumUser, userApi }) => {
      await clearTrades(userApi);
      await seedTrades(userApi, [
        aTrade({ symbol: 'BTCUSDT' }),
        aTrade({ symbol: 'ETHUSDT', openedAt: '2026-01-16T10:00:00.000Z', pnl: -40 }),
      ]);

      const page = await pageAs(premiumUser, { theme });
      const journal = new JournalPage(page);
      await journal.open();
      await expect(journal.rows).toHaveCount(2);
      await expectNoNewViolations(page, `journal:${theme}`);
    });
  }

  test('the analytics page', async ({ authedPage, userApi }) => {
    await clearTrades(userApi);
    await seedTrades(userApi, [aTrade(), aTrade({ symbol: 'ETHUSDT', pnl: -30 })]);
    await authedPage.goto('/analytics');
    await expect(authedPage.getByText(t('eb.title'))).toHaveCount(0);
    await expectNoNewViolations(authedPage, 'analytics');
  });

  test('the profile page', async ({ authedPage }) => {
    await authedPage.goto('/profile');
    await expectNoNewViolations(authedPage, 'profile');
  });

  test('the paywall', async ({ pageAs, freeUser }) => {
    const page = await pageAs(freeUser);
    await page.goto('/billing');
    await expectNoNewViolations(page, 'billing');
  });
});

test.describe('dialogs', () => {
  test('the trade form', async ({ authedPage }) => {
    const journal = new JournalPage(authedPage);
    await journal.open();
    await journal.openCreateForm();
    // Scanned with the dialog OPEN: a modal is where focus management and
    // labelling problems live, and the page behind it has already been scanned.
    await expectNoNewViolations(authedPage, 'trade-form');
  });

  test('the import wizard, at the file step', async ({ authedPage }) => {
    const journal = new JournalPage(authedPage);
    await journal.open();
    await journal.importCsvButton.click();
    const wizard = new ImportWizard(authedPage);
    await wizard.open();
    await expectNoNewViolations(authedPage, 'import-file');
  });

  test('the import wizard, at the mapping step', async ({ authedPage }) => {
    const journal = new JournalPage(authedPage);
    await journal.open();
    await journal.importCsvButton.click();
    const wizard = new ImportWizard(authedPage);
    await wizard.open();
    await wizard.choose('mt5-20-trades.csv');
    // The step with the most controls on screen at once, and the one whose
    // selects had no accessible name at all until this suite looked.
    await expectNoNewViolations(authedPage, 'import-columns');
  });

  test('the delete confirmation', async ({ authedPage, userApi }) => {
    await clearTrades(userApi);
    await seedTrades(userApi, [aTrade({ symbol: 'DELUSDT' })]);

    const journal = new JournalPage(authedPage);
    await journal.open();
    await journal.row('DELUSDT').hover();
    await journal.rowAction('DELUSDT', 'delete').click();
    await authedPage.getByRole('dialog').waitFor({ state: 'visible' });

    await expectNoNewViolations(authedPage, 'delete-confirm');
  });
});
