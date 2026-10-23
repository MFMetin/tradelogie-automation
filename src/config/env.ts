import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required — copy .env.example to .env`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The guard rails.
 *
 * This suite deletes user rows and writes trades. Everything else in the repo
 * assumes it is pointed at a throwaway database on this machine, and the cost
 * of that assumption being wrong is somebody's real journal. So it is checked
 * here, once, at import — before a single test is collected — rather than
 * trusted to whoever last edited a .env.
 *
 * The database name has to be exact. "contains trading_journal" would happily
 * accept the development database, which is the one mistake worth preventing.
 */
function assertSafeDatabase(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }

  const name = parsed.pathname.replace(/^\//, '');
  if (name !== 'trading_journal_e2e') {
    throw new Error(
      `Refusing to run: DATABASE_URL points at "${name}". ` +
        'This suite truncates user rows and only ever runs against ' +
        'trading_journal_e2e. Run `npm run db:setup` to create it.',
    );
  }

  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(
      `Refusing to run: DATABASE_URL host is "${parsed.hostname}". ` +
        'Only a database on this machine is allowed.',
    );
  }
}

const webPort = num('WEB_PORT', 4180);
const apiPort = num('API_PORT', 8081);

export const APP_MODE = (process.env.APP_MODE ?? 'build') === 'dev' ? 'dev' : 'build';

/** Vite's own dev port, used only when APP_MODE=dev. */
const DEV_PORT = 5173;

export const env = {
  /** Where the browser goes. */
  baseURL: `http://localhost:${APP_MODE === 'dev' ? DEV_PORT : webPort}`,
  /** Where API-layer tests go, and what the built bundle is told to call. */
  apiURL: `http://localhost:${apiPort}/api/v1`,
  apiOrigin: `http://localhost:${apiPort}`,
  webPort: APP_MODE === 'dev' ? DEV_PORT : webPort,
  apiPort,

  webRepo: path.resolve(REPO_ROOT, process.env.WEB_REPO ?? '../trading_journal_web'),
  apiRepo: path.resolve(REPO_ROOT, process.env.API_REPO ?? '../trading_journal_backend'),

  databaseUrl: required('DATABASE_URL'),

  adminEmail: process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@tradelogie.test',
  adminPassword: process.env.E2E_ADMIN_PASSWORD ?? 'E2eAdminPassw0rd!',

  /**
   * The app defaults to Turkish and never consults navigator.language, so a
   * suite that does not pin this reads a different UI depending on whose
   * machine it runs on.
   */
  lang: (process.env.E2E_LANG === 'tr' ? 'tr' : 'en') as 'tr' | 'en',

  /**
   * Every address the suite creates. Also the WHERE clause global setup uses
   * to clean up, which is why it is a suffix and not a prefix.
   */
  testEmailDomain: '@tradelogie.test',

  mode: APP_MODE,
  isCI: !!process.env.CI,
} as const;

assertSafeDatabase(env.databaseUrl);
