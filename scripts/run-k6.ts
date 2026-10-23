import { binary } from './spawn';
import { env } from '../src/config/env';
import { createPremiumUser } from '../src/fixtures/users';
import { closePool } from '../src/db/pool';

/**
 * Runs the k6 profile against a local API, with a real token.
 *
 * Three jobs, none of which k6 can do on its own:
 *
 *   1. **Mint an account and give it some trades.** Loading `GET /trades`
 *      against an empty journal measures an empty query; the numbers only mean
 *      anything with rows behind them.
 *   2. **Pass the token in.** k6 has no way to register, verify and sign in
 *      through three endpoints, and hard-coding a token in a committed file is
 *      how tokens end up in git history.
 *   3. **Refuse to point at anything but localhost**, twice — here and again at
 *      the top of the script itself.
 *
 * The API has to already be running. Playwright owns it during a test run, so
 * start it separately:
 *
 *     cd ../trading_journal_backend
 *     PORT=8081 DISABLE_RATE_LIMIT=true npm run dev
 *
 * and then `npm run k6`. Without DISABLE_RATE_LIMIT the global ceiling of 120
 * requests a minute is reached in seconds and the run measures the limiter.
 */
const HOW_MANY_TRADES = 250;

async function main(): Promise<void> {
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(env.apiURL)) {
    throw new Error(`Refusing to load-test ${env.apiURL} — localhost only.`);
  }

  // Fails fast with something readable if the API is not up, rather than
  // handing k6 a run in which every request is a connection error.
  const health = await fetch(`${env.apiOrigin}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `No API on ${env.apiOrigin}. Start it first:\n` +
        '  cd ../trading_journal_backend && PORT=8081 DISABLE_RATE_LIMIT=true npm run dev',
    );
  }

  console.log('Minting a load-test account…');
  const user = await createPremiumUser('k6');

  const { newApiContext } = await import('../src/api/client');
  const { bulkImport } = await import('../src/api/trades');
  const { aTrade } = await import('../src/fixtures/data');

  const api = await newApiContext(user.accessToken);
  try {
    const rows = Array.from({ length: HOW_MANY_TRADES }, (_, index) =>
      aTrade({
        symbol: ['BTCUSDT', 'ETHUSDT', 'XAUUSD', 'EURUSD'][index % 4],
        sourceTradeId: `k6-${index}`,
        openedAt: new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString(),
        pnl: index % 3 === 0 ? -40 : 60,
      }),
    );
    const seeded = await bulkImport(api, rows);
    if (!seeded.ok()) throw new Error(`Seeding failed: ${await seeded.text()}`);
    console.log(`Seeded ${HOW_MANY_TRADES} trades for ${user.email}`);
  } finally {
    await api.dispose();
  }

  const result = binary(
    'k6',
    ['run', 'k6/api-load.js', ...process.argv.slice(2)],
    {
      env: {
        ...process.env,
        K6_BASE_URL: env.apiURL,
        K6_TOKEN: user.accessToken,
      },
    },
  );

  if (result.error) {
    // k6 is a Go binary, not an npm package, so it will not be there just
    // because `npm install` ran.
    throw new Error(
      [
        'Could not run k6. It is a single binary, not an npm package:',
        '  winget install k6 --source winget',
        '  brew install k6',
        '  https://grafana.com/docs/k6/latest/set-up/install-k6/',
      ].join('\n'),
    );
  }

  process.exitCode = result.status ?? 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
