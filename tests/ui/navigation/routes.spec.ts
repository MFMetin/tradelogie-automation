import { test, expect, KEYS } from '../../../src/fixtures/base';
import { AppShell } from '../../../src/pages/AppShell';
import { t, tIn } from '../../../src/utils/i18n';

/** Every premium-gated feature route, from App.tsx. */
const FEATURE_ROUTES = ['/dashboard', '/journal', '/markets', '/analytics', '/education'] as const;

/** Reachable with a session but no subscription. */
const PLAIN_ROUTES = [
  '/profile',
  '/billing',
  '/feedback',
  '/achievements',
  '/leaderboard',
] as const;

/** The four legal documents, all rendered by one component keyed on pathname. */
const LEGAL_ROUTES = [
  { path: '/privacy', titleKey: 'legal.privacy' },
  { path: '/terms', titleKey: 'legal.terms' },
  { path: '/kvkk', titleKey: 'legal.kvkk' },
  { path: '/distance-sales', titleKey: 'legal.distanceSales' },
] as const;

const endsWith = (path: string) => new RegExp(`${path.replace(/\//g, '\\/')}$`);

test.describe('reaching every route', () => {
  for (const path of [...FEATURE_ROUTES, ...PLAIN_ROUTES]) {
    test(`${path} renders for a premium user`, async ({ authedPage }) => {
      await authedPage.goto(path);

      await expect(authedPage).toHaveURL(endsWith(path));

      // Content alone is not enough. `AppErrorBoundary`'s fallback renders
      // INSIDE <main>, so "the route rendered something" is true of a page that
      // threw — and a completely dead /analytics passed this test until the
      // crash check was added. There is no error tracking in this app by
      // choice, so noticing this is the suite's job.
      await expect(
        authedPage.getByText(t('eb.title')),
        'the route rendered AppErrorBoundary — something threw during render',
      ).toHaveCount(0);

      await expect(authedPage.locator('main').first()).not.toBeEmpty();
    });
  }

  test('the nav takes you to each section', async ({ authedPage }) => {
    const shell = new AppShell(authedPage);
    await authedPage.goto('/dashboard');

    for (const path of ['/journal', '/analytics', '/education']) {
      await shell.navigateTo(path);
      await expect(authedPage).toHaveURL(endsWith(path));
      await expect(authedPage.getByText(t('eb.title'))).toHaveCount(0);
    }
  });
});

test.describe('the catch-all', () => {
  test('an unknown path renders the not-found page, it does not redirect', async ({
    anonPage,
  }) => {
    await anonPage.goto('/definitely-not-a-page');

    // `path="*"` renders NotFoundPage rather than navigating to '/'. A redirect
    // threw the typo away silently and handed crawlers a 200 for every address.
    await expect(anonPage).toHaveURL(/\/definitely-not-a-page$/);
    await expect(anonPage.getByText(/404/)).toBeVisible();
  });

  test('a non-admin asking for /admin gets the not-found page', async ({ authedPage }) => {
    await authedPage.goto('/admin');

    // Not a bounce to the dashboard: that would confirm there is something
    // there. `/404` has no route of its own — the catch-all renders it.
    await expect(authedPage).toHaveURL(/\/404$/);
    await expect(authedPage.getByText(/404/)).toBeVisible();
  });
});

test.describe('the legal documents', () => {
  for (const { path, titleKey } of LEGAL_ROUTES) {
    test(`${path} renders while signed out`, async ({ anonPage }) => {
      await anonPage.goto(path);
      await expect(anonPage.getByRole('heading', { name: t(titleKey) })).toBeVisible();
    });
  }

  test('they render while signed in too', async ({ authedPage }) => {
    // Outside PublicOnlyRoute on purpose, for the same reason the email links
    // are: a signed-in person following a link must get the page, not a bounce.
    for (const { path, titleKey } of LEGAL_ROUTES) {
      await authedPage.goto(path);
      await expect(authedPage.getByRole('heading', { name: t(titleKey) })).toBeVisible();
    }
  });
});

test.describe('preferences', () => {
  test('the theme toggle persists across a reload', async ({ authedPage }) => {
    const shell = new AppShell(authedPage);
    await authedPage.goto('/dashboard');

    // The fixture seeds dark, and the pre-paint snippet in index.html reads it
    // before React exists — so this is already the state on first paint.
    expect(await shell.theme()).toBe('dark');

    await shell.themeToggle.click();
    expect(await shell.theme()).toBe('light');

    await authedPage.reload();
    expect(await shell.theme()).toBe('light');
    expect(await authedPage.evaluate((key) => localStorage.getItem(key), KEYS.theme)).toBe(
      'light',
    );
  });

  test('the language toggle switches the UI and the document language', async ({
    authedPage,
  }) => {
    const shell = new AppShell(authedPage);
    await authedPage.goto('/journal');

    // The suite pins English; the app's own default is Turkish.
    expect(await shell.htmlLang()).toBe('en');
    await expect(
      authedPage.getByRole('button', { name: tIn('dash.logTrade', 'en') }).first(),
    ).toBeVisible();

    await shell.languageToggle.click();

    expect(await shell.htmlLang()).toBe('tr');
    await expect(
      authedPage.getByRole('button', { name: tIn('dash.logTrade', 'tr') }).first(),
    ).toBeVisible();
    expect(await authedPage.evaluate((key) => localStorage.getItem(key), KEYS.lang)).toBe('tr');
  });

  test('a page loads in Turkish when storage says so', async ({ pageAs, premiumUser }) => {
    // The whole reason the suite seeds this before the bundle evaluates:
    // `LanguageContext` resolves the language at module load, so a post-load
    // write would render the first paint in the wrong language and then flip.
    const page = await pageAs(premiumUser, { lang: 'tr' });
    await page.goto('/journal');

    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(
      page.getByRole('button', { name: tIn('dash.logTrade', 'tr') }).first(),
    ).toBeVisible();
  });
});

test.describe('the streak', () => {
  test('the top bar shows the day the server counted', async ({ authedPage, premiumUser }) => {
    await authedPage.goto('/dashboard');
    const shell = new AppShell(authedPage);
    // Below `lg` the XP and streak strip is rendered inside the drawer, not in
    // the top bar, so on a phone it does not exist until the nav is opened.
    await shell.openNav();

    // There is no streak endpoint: the server counts the day on `/users/me`,
    // login and verify-email — the three calls that already return a user — so
    // whatever `AuthContext` holds is simply correct. A freshly created account
    // has signed in at least once, so its streak is day one. It used to read 0
    // for every account, because the endpoint that existed was never called.
    await expect(shell.streakBadge).toBeVisible();
    expect(await shell.streakDays()).toBeGreaterThanOrEqual(1);
    expect(premiumUser.user.streakDays).toBeGreaterThanOrEqual(1);
  });
});
