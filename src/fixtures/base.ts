import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { env } from '../config/env';
import { newApiContext } from '../api/client';
import { readAdminState } from './globalSetup';
import { createPremiumUser, createVerifiedUser, type TestUser } from './users';

/**
 * Storage keys the real app uses. Taken from the source, not guessed:
 * lib/api.ts for the two tokens, AuthContext for the cached profile,
 * LanguageContext and ThemeContext for the two preferences.
 */
const KEYS = {
  access: 'tj_access_token',
  refresh: 'tj_refresh_token',
  user: 'tj_user',
  lang: 'tradeup-lang',
  theme: 'tradeup-theme',
} as const;

export type Theme = 'dark' | 'light';

export interface AppPageOptions {
  theme?: Theme;
  lang?: 'tr' | 'en';
  session?: TestUser | null;
}

/**
 * Everything a page needs before the bundle evaluates.
 *
 * `addInitScript` and not `evaluate`: LanguageContext resolves the language at
 * module load (`setFormatLanguage(getInitialLanguage())`) and ThemeContext's
 * value is read by an inline script in index.html before first paint. Writing
 * these after load means the first render is in the wrong language and the
 * page then flips, which is both a flake and a wrong screenshot.
 */
export async function primePage(page: Page, options: AppPageOptions = {}): Promise<void> {
  const theme: Theme = options.theme ?? 'dark';
  const lang = options.lang ?? env.lang;
  const session = options.session ?? null;

  await page.addInitScript(
    ({ keys, lang: language, theme: colour, session: account }) => {
      try {
        localStorage.setItem(keys.lang, language);
        localStorage.setItem(keys.theme, colour);
        if (account) {
          localStorage.setItem(keys.access, account.accessToken);
          localStorage.setItem(keys.refresh, account.refreshToken);
          // The cached profile is what makes the first paint the real page.
          // Without it AuthContext starts `initializing` and the guards show a
          // loader until /users/me answers — a race every navigation re-runs.
          localStorage.setItem(keys.user, JSON.stringify(account.user));
        } else {
          localStorage.removeItem(keys.access);
          localStorage.removeItem(keys.refresh);
          localStorage.removeItem(keys.user);
        }
      } catch {
        // A storage-denied context would mean the app itself cannot run; the
        // navigation that follows will say so far more clearly than a throw here.
      }
    },
    { keys: KEYS, lang, theme, session },
  );

  // lib/traffic.ts fires page-view beacons from the production bundle, which is
  // what the suite serves. They would write rows the whole run and show up in
  // any test that counts requests.
  await page.route('**/analytics/**', (route) => route.fulfill({ status: 204, body: '' }));
}

interface Fixtures {
  /** A page with language, theme and no session pinned. */
  anonPage: Page;
  /** A page already signed in as a premium account, with the cache warm. */
  authedPage: Page;
  /** The account `authedPage` is signed in as. */
  premiumUser: TestUser;
  /** Verified, not premium — for the paywall tests. */
  freeUser: TestUser;
  /** API context as `premiumUser`. */
  userApi: APIRequestContext;
  /** API context with no credentials. */
  anonApi: APIRequestContext;
  /** API context as the bootstrap admin. */
  adminApi: APIRequestContext;
}

interface WorkerFixtures {
  /**
   * One account per worker, not per test.
   *
   * adminWriteLimiter allows 30 admin mutations a minute and creating a user
   * costs two of them, so a per-test account would meter the suite at fifteen
   * tests a minute per worker. Per-worker it is two calls per worker per run.
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

  anonPage: async ({ page }, use) => {
    await primePage(page);
    await use(page);
  },

  authedPage: async ({ page, workerUser }, use) => {
    await primePage(page, { session: workerUser });
    await use(page);
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
