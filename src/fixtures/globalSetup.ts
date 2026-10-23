import { env } from '../config/env';
import { newApiContext } from '../api/client';
import { deleteAllTestUsers } from '../db/users';
import { ensureAdmin, ADMIN_STATE, readAdminState, type AdminState } from './admin';

// Re-exported so the many modules that already import these from here keep
// working; the implementation moved to ./admin so scripts can use it too.
export { ADMIN_STATE, readAdminState };
export type { AdminState };

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

  const admin = await ensureAdmin();
  console.log(`[setup] admin ready: ${admin.email}`);
}
