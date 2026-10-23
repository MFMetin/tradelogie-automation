import { defineConfig, devices } from '@playwright/test';

/**
 * Read-only smoke tests against the live site.
 *
 * Deliberately self-contained: this config and the tests under
 * `tests/smoke-prod/` import nothing from `src/`, and in particular not
 * `src/config/env.ts` — which exists to refuse any database but the local
 * throwaway one, and has no business being loaded by a run that must never
 * touch a database at all.
 *
 * Nothing here signs in, writes, or needs a secret. Everything is a GET that a
 * crawler could make: the public pages render, the four legal documents are
 * reachable, an unknown address answers 404, the security headers are present
 * and the SEO assets are intact. That is a badge whose green means something —
 * it is checking the thing real visitors get — while being incapable of
 * creating an account or spending anyone's rate limit.
 *
 *     npm run test:smoke
 */
const BASE_URL = process.env.SMOKE_BASE_URL ?? 'https://tradelogie.com';

if (!/^https:\/\//.test(BASE_URL)) {
  throw new Error(`SMOKE_BASE_URL must be an https URL, got "${BASE_URL}"`);
}

export default defineConfig({
  testDir: './tests/smoke-prod',

  fullyParallel: true,
  // Modest: this is someone's production site, not a load test.
  workers: 2,
  // A transient network failure against the public internet is not a finding.
  retries: 2,
  timeout: 45_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
});
