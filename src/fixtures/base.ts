import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { env } from '../config/env';
import { newApiContext } from '../api/client';
import { readAdminState } from './globalSetup';
import { createPremiumUser, createVerifiedUser, type TestUser } from './users';

/**
 * Storage keys the real app uses, read from its source rather than guessed:
 * `lib/api.ts` for the two tokens, `AuthContext` for the cached profile,
 * `LanguageContext` and `ThemeContext` for the two preferences.
 */
export const KEYS = {
  access: 'tj_access_token',
  refresh: 'tj_refresh_token',
  user: 'tj_user',
  lang: 'tradeup-lang',
  theme: 'tradeup-theme',
} as const;

export type Theme = 'dark' | 'light';

export interface SessionOptions {
  theme?: Theme;
  lang?: 'tr' | 'en';
  session?: TestUser | null;
}

/**
 * Builds the `storageState` a context starts with.
 *
 * `storageState` and not `addInitScript`, and the difference is a bug this
 * suite actually had: an init script runs on EVERY navigation, so after a test
 * signed out, the next `goto` wrote the tokens straight back and the protected
 * route opened. The test asserting that sign-out works passed while proving
 * the opposite.
 *
 * Seeding the context once is also the only way to get the language right.
 * `LanguageContext` resolves it at module load and the pre-paint snippet in
 * index.html reads the theme before React exists, so both have to be in place
 * before the bundle evaluates — which rules out a post-load `evaluate`.
 */
export function storageStateFor(options: SessionOptions = {}) {
  const items: { name: string; value: string }[] = [
    // The app defaults to Turkish and never consults navigator.language, so a
    // suite that does not pin this reads a different UI per machine.
    { name: KEYS.lang, value: options.lang ?? env.lang },
    { name: KEYS.theme, value: options.theme ?? 'dark' },
  ];

  if (options.session) {
    items.push(
      { name: KEYS.access, value: options.session.accessToken },
      { name: KEYS.refresh, value: options.session.refreshToken },
      // The cached profile is what makes the first paint the real page. Without
      // it AuthContext starts `initializing` and the guards render a loader
      // until /users/me answers — a race every navigation re-runs.
      { name: KEYS.user, value: JSON.stringify(options.session.user) },
    );
  }

  return {
    cookies: [],
    origins: [{ origin: env.baseURL, localStorage: items }],
  };
}

/**
 * Per-page setup that genuinely does belong on every navigation.
 *
 * `lib/traffic.ts` fires page-view beacons from the production bundle, which is
 * what this suite serves. Left alone they write rows for the whole run and turn
 * up in any test that counts requests.
 */
export async function blockAnalytics(page: Page): Promise<void> {
  await page.route('**/analytics/**', (route) => route.fulfill({ status: 204, body: '' }));
}

interface Fixtures {
  /** A context with the preferences pinned and no session. */
  anonContext: BrowserContext;
  anonPage: Page;
  /** A context already signed in as a premium account, cache warm. */
  authedContext: BrowserContext;
  authedPage: Page;
  /** The account `authedPage` is signed in as. */
  premiumUser: TestUser;
  /** Verified, not premium — for the paywall tests. */
  freeUser: TestUser;
  /** A page for any account, or for none, with the preferences overridable. */
  pageAs: (user: TestUser | null, options?: SessionOptions) => Promise<Page>;
  userApi: APIRequestContext;
  anonApi: APIRequestContext;
  adminApi: APIRequestContext;
}

interface WorkerFixtures {
  /**
   * One account per worker, not per test.
   *
   * `adminWriteLimiter` allows thirty admin mutations a minute and creating an
   * account costs two, so a per-test account would meter the suite at fifteen
   * tests a minute per worker. Per worker it is two calls for the whole run.
   * Tests in one worker therefore share a journal, which is why anything
   * asserting on a whole listing clears it first (`fixtures/data.ts`).
   */
  workerUser: TestUser;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  workerUser: [
    async ({}, use, workerInfo) => {
      const user = await createPremiumUser(`w${workerInfo.workerIndex}`);
      await use(user);
    },
    { scope: 'worker' },
  ],

  premiumUser: async ({ workerUser }, use) => {
    await use(workerUser);
  },

  freeUser: async ({}, use) => {
    await use(await createVerifiedUser());
  },

  anonContext: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: storageStateFor() });
    await use(context);
    await context.close();
  },

  anonPage: async ({ anonContext }, use) => {
    const page = await anonContext.newPage();
    await blockAnalytics(page);
    await use(page);
  },

  authedContext: async ({ browser, workerUser }, use) => {
    const context = await browser.newContext({
      storageState: storageStateFor({ session: workerUser }),
    });
    await use(context);
    await context.close();
  },

  authedPage: async ({ authedContext }, use) => {
    const page = await authedContext.newPage();
    await blockAnalytics(page);
    await use(page);
  },

  pageAs: async ({ browser }, use) => {
    const opened: BrowserContext[] = [];

    await use(async (user, options = {}) => {
      const context = await browser.newContext({
        storageState: storageStateFor({ ...options, session: user }),
      });
      opened.push(context);
      const page = await context.newPage();
      await blockAnalytics(page);
      return page;
    });

    for (const context of opened) await context.close();
  },

  userApi: async ({ workerUser }, use) => {
    const api = await newApiContext(workerUser.accessToken);
    await use(api);
    await api.dispose();
  },

  anonApi: async ({}, use) => {
    const api = await newApiContext();
    await use(api);
    await api.dispose();
  },

  adminApi: async ({}, use) => {
    const api = await newApiContext(readAdminState().accessToken);
    await use(api);
    await api.dispose();
  },
});

export { expect };
export type { TestUser };
