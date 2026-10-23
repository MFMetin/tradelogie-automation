import fs from 'node:fs';
import path from 'node:path';
import { env, REPO_ROOT } from '../config/env';
import { newApiContext } from '../api/client';
import { loginOrThrow } from '../api/auth';
import { insertAdminUser, deleteAllTestUsers } from '../db/users';

export const ADMIN_STATE = path.join(REPO_ROOT, '.auth', 'admin.json');

/**
 * Fails the run, once, if the API still has its rate limiters on.
 *
 * The suite is built to run with them off — `playwright.config.ts` passes
 * `DISABLE_RATE_LIMIT` to the backend it starts — because the global ceiling is
 * 120 requests a minute per IP and a parallel run exceeds it in seconds.
 *
 * When that does not take effect, the symptom is catastrophic and says nothing:
 * every test that creates an account queues behind `adminWriteLimiter`, and the
 * run dies of a hundred-odd 90-second timeouts across unrelated files. It
 * happened for real — CI checked out a revision of the API from before the flag
 * existed — and reading 187 red tests to find one missing environment variable
 * is not an experience worth repeating.
 *
 * `RateLimit-Limit` is the tell: `express-rate-limit` sends it with
 * `standardHeaders`, and a passthrough sends nothing at all.
 *
 * The one configuration that WANTS the limiters on says so, so this check is
 * skipped there.
 */
async function assertLimitersAreOff(): Promise<void> {
  if (process.env.DISABLE_RATE_LIMIT === 'false') return;

  const api = await newApiContext();
  try {
    const response = await api.get('users/me');
    if (response.headers()['ratelimit-limit']) {
      throw new Error(
        'The API has its rate limiters ON, and this suite cannot run against that.\n' +
          '\n' +
          '  The global ceiling is 120 requests a minute per IP. A parallel run\n' +
          '  exceeds it within seconds, and the failure looks like a hundred\n' +
          '  unrelated timeouts rather than a configuration problem.\n' +
          '\n' +
          '  playwright.config.ts passes DISABLE_RATE_LIMIT=true to the backend it\n' +
          '  starts. If it is not taking effect, check that the API revision in\n' +
          `  ${env.apiRepo}\n` +
          '  actually supports the flag (src/config/env.ts -> disableRateLimit),\n' +
          '  and that `reuseExistingServer` has not handed the suite an API that\n' +
          '  somebody else started without it.',
      );
    }
  } finally {
    await api.dispose();
  }
}

/**
 * Runs once, before anything is collected.
 *
 * Three jobs. First, refuse to start against an API whose limiters are on, for
 * the reason above. Second, clear out every account the suite has ever created,
 * so a run never inherits state from the last one — a test that passes only
 * because yesterday's data happens to be there is worse than no test. Third,
 * make sure the admin exists and its token is on disk, because that admin is
 * what lets every worker mint its own user over HTTP rather than writing rows.
 *
 * `src/config/env.ts` has already refused to load if DATABASE_URL is anything
 * but the local trading_journal_e2e, so the DELETE below cannot reach real data.
 */
export default async function globalSetup(): Promise<void> {
  await assertLimitersAreOff();

  const removed = await deleteAllTestUsers();
  if (removed > 0) console.log(`[setup] removed ${removed} leftover test account(s)`);

  const admin = await insertAdminUser(env.adminEmail, env.adminPassword);

  const api = await newApiContext();
  try {
    const session = await loginOrThrow(api, admin.email, admin.password);

    if (session.user.role !== 'admin') {
      // The role is granted at registration from ADMIN_EMAILS, and this row is
      // inserted with it directly — so this only fires if the insert changed.
      throw new Error(
        `Bootstrap account is role "${session.user.role}", not admin. ` +
          'Fixtures cannot verify or grant premium to other accounts without it.',
      );
    }

    fs.mkdirSync(path.dirname(ADMIN_STATE), { recursive: true });
    fs.writeFileSync(
      ADMIN_STATE,
      JSON.stringify(
        {
          id: session.user_id,
          email: admin.email,
          password: admin.password,
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          user: session.user,
        },
        null,
        2,
      ),
    );
    console.log(`[setup] admin ready: ${admin.email}`);
  } finally {
    await api.dispose();
  }
}

export interface AdminState {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export function readAdminState(): AdminState {
  if (!fs.existsSync(ADMIN_STATE)) {
    throw new Error(`Admin state missing at ${ADMIN_STATE} — did global setup run?`);
  }
  return JSON.parse(fs.readFileSync(ADMIN_STATE, 'utf8')) as AdminState;
}
