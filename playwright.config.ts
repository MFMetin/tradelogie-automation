import { defineConfig, devices } from '@playwright/test';
import { env, APP_MODE } from './src/config/env';

/**
 * The suite starts both halves of the application itself, so a run is one
 * command on a clean machine and CI needs no orchestration of its own.
 *
 * The web client is BUILT and served by the project's own `server.js` rather
 * than run under `vite dev`, because several tests are about that server: real
 * 404 statuses from `dist/routes.json`, the CSP whose `script-src` is a hash of
 * the inline theme snippet, brotli, and `immutable` caching on `dist/assets/`.
 * None of it exists under the dev server. `APP_MODE=dev` swaps in Vite for a
 * faster edit loop and drops the server-contract project, which would then be
 * asserting against something that isn't shipped.
 */
const BACKEND_ENV: Record<string, string> = {
  PORT: String(env.apiPort),
  DATABASE_URL: env.databaseUrl,
  NODE_ENV: 'development',

  // 120 requests a minute per IP is below what a parallel UI suite spends, and
  // the flag is refused outright when NODE_ENV is production.
  DISABLE_RATE_LIMIT: 'true',

  // The paywall's test door, used by the billing test.
  ENABLE_MOCK_BILLING: 'true',

  // Non-prod CORS only adds :5173 and :4173 automatically. The built bundle is
  // served from another port, and without naming it here the browser blocks
  // every API call the app makes — which looks exactly like a broken app.
  ALLOWED_ORIGINS: env.baseURL,

  // Also the base of the verification and reset links the API composes.
  APP_WEB_URL: env.baseURL,

  // Grants `role: admin` at registration, which is what makes the bootstrap
  // account able to verify and grant premium to every other test user.
  ADMIN_EMAILS: env.adminEmail,
};

/**
 * The web half, as one shape rather than a ternary — a conditional object
 * widens each branch's `env` with `undefined` members and stops matching
 * Playwright's `{ [key: string]: string }`.
 */
const isDev = APP_MODE === 'dev';

const webEnv: Record<string, string> = isDev
  ? { VITE_API_BASE_URL: env.apiURL }
  : {
      PORT: String(env.webPort),
      VITE_API_BASE_URL: env.apiURL,
      // Without this the seoAssets plugin emits nothing — including
      // dist/routes.json, and server.js falls back to answering 200 for every
      // path, which silently makes the real-404 test meaningless.
      VITE_SITE_URL: env.baseURL,
    };

const webServers = [
  {
    command: 'npm run dev',
    cwd: env.apiRepo,
    url: `${env.apiOrigin}/health`,
    env: BACKEND_ENV,
    reuseExistingServer: !env.isCI,
    timeout: 120_000,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  },
  {
    command: isDev ? 'npm run dev' : 'npm run build && npm start',
    cwd: env.webRepo,
    url: isDev ? env.baseURL : `${env.baseURL}/healthz`,
    env: webEnv,
    reuseExistingServer: !env.isCI,
    timeout: isDev ? 180_000 : 300_000,
  },
];

export default defineConfig({
  testDir: './tests',
  globalSetup: './src/fixtures/globalSetup.ts',
  globalTeardown: './src/fixtures/globalTeardown.ts',

  fullyParallel: true,
  forbidOnly: !!env.isCI,
  retries: env.isCI ? 2 : 0,
  workers: env.isCI ? 4 : undefined,
  // Roomy on purpose. A test that needs its own account waits out
  // `adminWriteLimiter` when several workers ask at once — every fixture
  // account in the run is minted by the same admin, and the suite respects
  // that limiter rather than switching it off. 45s was not enough for a test
  // that spent 30 of them being politely throttled, and the failure read as
  // the test being slow rather than as the suite queueing.
  timeout: 90_000,
  expect: { timeout: 10_000 },

  reporter: env.isCI
    ? [
        ['list'],
        ['html', { open: 'never' }],
        ['allure-playwright', { resultsDir: 'allure-results' }],
        ['github'],
      ]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: env.baseURL,
    // Retained on the first retry only: a trace per passing test is gigabytes
    // of artifact nobody opens, and the first retry is where a flake shows up.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      // No browser at all. Fastest layer, and the one that pins the contract
      // the UI is written against.
      name: 'api',
      testDir: './tests/api',
      // The limiters run as a passthrough here, so the tests that assert they
      // exist live in playwright.ratelimit.config.ts instead.
      testIgnore: '**/rate-limit.spec.ts',
      use: { baseURL: env.apiURL },
    },
    {
      name: 'ui-desktop',
      testDir: './tests/ui',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      // The journal renders cards instead of a table below `lg`, and the top
      // bar and filters collapse. Same page objects, different tree.
      name: 'ui-mobile',
      testDir: './tests/ui',
      grepInvert: /@desktop-only/,
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'server-contract',
      testDir: './tests/server',
      use: { baseURL: env.baseURL },
    },
    {
      name: 'a11y',
      testDir: './tests/a11y',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'visual',
      testDir: './tests/visual',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ].filter((project) => !(APP_MODE === 'dev' && project.name === 'server-contract')),

  webServer: webServers,

  // Platform-suffixed so a Windows run never compares against a Linux baseline.
  // Font rasterisation differs enough to fail every screenshot; only the Linux
  // set is committed (see docs/ARCHITECTURE.md).
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{testFilePath}/{arg}{ext}',
});
