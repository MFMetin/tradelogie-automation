import { test, expect } from '../../src/fixtures/base';
import { settleForScreenshot, freezeClock, volatileRegions } from '../../src/utils/visual';
import { JournalPage } from '../../src/pages/JournalPage';
import { KNOWN_SET, clearTrades } from '../../src/fixtures/data';
import { bulkImport } from '../../src/api/trades';
import { newApiContext } from '../../src/api/client';
import type { TestUser } from '../../src/fixtures/base';

/**
 * Visual regression.
 *
 * ## Baselines are generated in CI, on Linux, and nowhere else
 *
 * Font rasterisation differs per platform — different hinting, different
 * subpixel rounding — so a baseline taken on Windows fails on the GitHub
 * runner on every single pixel of every glyph, and vice versa. This is the one
 * thing most visual-regression setups get wrong, and the symptom is a suite
 * that is red for everyone except the person who last pressed
 * `--update-snapshots`.
 *
 * So: `snapshotPathTemplate` includes `{platform}`, `.gitignore` excludes the
 * darwin and win32 directories, and `.github/workflows/visual.yml` is the only
 * thing that writes the committed set. Locally these run against your own
 * platform's baselines, which are yours alone.
 *
 * ## What is actually asserted
 *
 * Layout and colour, not chart pixels. The data is a fixed five-trade set, the
 * clock is pinned, animations are off and charts are masked — see
 * `src/utils/visual.ts` for why each of those is necessary rather than
 * defensive.
 */
async function seedFixedJournal(user: TestUser): Promise<void> {
  const api = await newApiContext(user.accessToken);
  try {
    await clearTrades(api);
    await bulkImport(api, KNOWN_SET);
  } finally {
    await api.dispose();
  }
}

const SHOT = {
  // Generous enough to absorb one stray anti-aliased edge, tight enough that a
  // moved element or a changed colour still fails.
  maxDiffPixelRatio: 0.01,
  animations: 'disabled' as const,
  // Beyond the viewport too: a layout that breaks below the fold is still
  // broken, and the landing page is mostly below the fold.
  fullPage: true,
};

test.describe('signed out', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`the landing page (${theme})`, async ({ pageAs }) => {
      const page = await pageAs(null, { theme });
      await freezeClock(page);
      await page.goto('/');
      await settleForScreenshot(page);

      await expect(page).toHaveScreenshot(`landing-${theme}.png`, {
        ...SHOT,
        mask: volatileRegions(page),
      });
    });

    test(`the sign-in page (${theme})`, async ({ pageAs }) => {
      const page = await pageAs(null, { theme });
      await page.goto('/login');
      await settleForScreenshot(page);

      await expect(page).toHaveScreenshot(`login-${theme}.png`, SHOT);
    });
  }

  test('a legal document', async ({ anonPage }) => {
    await anonPage.goto('/privacy');
    await settleForScreenshot(anonPage);
    // These are the pages whose text is structured data rather than Markdown,
    // and the `{{…}}` placeholders plus the draft banner come out together
    // when the real company details land. A screenshot is how that lands
    // visibly rather than silently.
    await expect(anonPage).toHaveScreenshot('legal-privacy.png', SHOT);
  });

  test('the not-found page', async ({ anonPage }) => {
    await anonPage.goto('/definitely-not-a-page');
    await settleForScreenshot(anonPage);
    await expect(anonPage).toHaveScreenshot('not-found.png', SHOT);
  });
});

test.describe('signed in, with a fixed journal', () => {
  test.beforeEach(async ({ premiumUser }) => {
    await seedFixedJournal(premiumUser);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`the dashboard (${theme})`, async ({ pageAs, premiumUser }) => {
      const page = await pageAs(premiumUser, { theme });
      await freezeClock(page);
      await page.goto('/dashboard');
      await settleForScreenshot(page);

      await expect(page).toHaveScreenshot(`dashboard-${theme}.png`, {
        ...SHOT,
        mask: volatileRegions(page),
      });
    });

    test(`the journal (${theme})`, async ({ pageAs, premiumUser }) => {
      const page = await pageAs(premiumUser, { theme });
      await freezeClock(page);
      const journal = new JournalPage(page);
      await journal.open();
      await expect(journal.rows).toHaveCount(5);
      await settleForScreenshot(page);

      await expect(page).toHaveScreenshot(`journal-${theme}.png`, {
        ...SHOT,
        mask: volatileRegions(page),
      });
    });
  }

  test('the analytics page', async ({ authedPage }) => {
    await freezeClock(authedPage);
    await authedPage.goto('/analytics');
    await settleForScreenshot(authedPage);

    // The charts are masked, so what this asserts is the layout around them and
    // the four stat tiles — whose numbers are fixed by the seeded set and
    // separately checked against hand arithmetic in tests/ui/analytics.
    await expect(authedPage).toHaveScreenshot('analytics.png', {
      ...SHOT,
      mask: volatileRegions(authedPage),
    });
  });

  test('the trade form', async ({ authedPage }) => {
    const journal = new JournalPage(authedPage);
    await journal.open();
    await journal.openCreateForm();
    await settleForScreenshot(authedPage);

    // Just the dialog: the page behind it has its own shot, and including it
    // would make every journal change fail this one too.
    await expect(journal.tradeForm.root).toHaveScreenshot('trade-form.png', {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    });
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the journal renders as cards', async ({ pageAs, premiumUser }) => {
    await seedFixedJournal(premiumUser);
    const page = await pageAs(premiumUser);
    await freezeClock(page);

    const journal = new JournalPage(page);
    await journal.open();
    await expect(journal.rows).toHaveCount(5);
    await settleForScreenshot(page);

    // The layout three recent commits were about. A screenshot is the only
    // thing that would notice the table coming back.
    await expect(page).toHaveScreenshot('journal-mobile.png', {
      ...SHOT,
      mask: volatileRegions(page),
    });
  });

  test('the landing page', async ({ pageAs }) => {
    const page = await pageAs(null);
    await freezeClock(page);
    await page.goto('/');
    await settleForScreenshot(page);

    await expect(page).toHaveScreenshot('landing-mobile.png', {
      ...SHOT,
      mask: volatileRegions(page),
    });
  });
});
