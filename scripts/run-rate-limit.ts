import { spawnSync } from 'node:child_process';

/**
 * Runs the rate-limit project against a backend of its own.
 *
 * A launcher rather than an env prefix in the npm script, because
 * `API_PORT=8082 playwright test` is a syntax error in PowerShell and cmd, and
 * this project is developed on Windows. Setting it here works in every shell
 * and keeps the one fact that matters — a second port, limiters left on — in
 * one readable place.
 */
const PORT = process.env.RATE_LIMIT_API_PORT ?? '8082';

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'test', '--config=playwright.ratelimit.config.ts', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      API_PORT: PORT,
      // Explicitly cleared: inheriting it from a shell that ran the main suite
      // would silently skip every test in the file.
      DISABLE_RATE_LIMIT: 'false',
    },
  },
);

process.exit(result.status ?? 1);
