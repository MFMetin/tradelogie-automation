import { defineConfig } from '@playwright/test';
import { env } from './src/config/env';

/**
 * The limiters, on.
 *
 * The main run sets `DISABLE_RATE_LIMIT`, so the limiters there are
 * passthroughs — a parallel UI suite spends more than 120 requests a minute
 * loading pages and would otherwise spend the whole run proving it had been
 * throttled. That would leave a security control untested, so it gets a
 * configuration of its own: a second backend on its own port, started WITHOUT
 * the flag, and nothing else running against it.
 *
 * Its own port rather than the main one because `reuseExistingServer` would
 * otherwise hand these tests the already-running, unlimited process — and every
 * assertion would skip or fail for the wrong reason.
 *
 * Launched through `scripts/run-rate-limit.ts`, which sets API_PORT before this
 * file imports `env`. Run it with `npm run test:ratelimit`.
 */
export default defineConfig({
  testDir: './tests/api',
  testMatch: '**/rate-limit.spec.ts',
  globalSetup: './src/fixtures/globalSetup.ts',
  globalTeardown: './src/fixtures/globalTeardown.ts',

  // The buckets are per-IP and in memory. Two workers would spend each other's
  // budget and neither assertion would mean anything.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // One test deliberately sends ~130 requests to find the ceiling.
  timeout: 180_000,

  reporter: [['list']],

  use: {
    baseURL: `${env.apiURL}/`,
    trace: 'retain-on-failure',
  },

  webServer: [
    {
      command: 'npm run dev',
      cwd: env.apiRepo,
      url: `${env.apiOrigin}/health`,
      env: {
        PORT: String(env.apiPort),
        DATABASE_URL: env.databaseUrl,
        NODE_ENV: 'development',
        // Absent on purpose. This is the whole point of the configuration.
        ENABLE_MOCK_BILLING: 'true',
        ADMIN_EMAILS: env.adminEmail,
        APP_WEB_URL: env.baseURL,
        ALLOWED_ORIGINS: env.baseURL,
      },
      // Never reuse: an existing process on this port may have a spent bucket
      // from the last run, since the window is up to an hour long.
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
