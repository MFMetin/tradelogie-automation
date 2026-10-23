import fs from 'node:fs';
import path from 'node:path';
import { env, REPO_ROOT } from '../config/env';
import { newApiContext } from '../api/client';
import { loginOrThrow } from '../api/auth';
import { insertAdminUser, deleteAllTestUsers } from '../db/users';

export const ADMIN_STATE = path.join(REPO_ROOT, '.auth', 'admin.json');

/**
 * Runs once, before anything is collected.
 *
 * Two jobs. First, clear out every account the suite has ever created, so a run
 * never inherits state from the last one — a test that passes only because
 * yesterday's data happens to be there is worse than no test. Second, make sure
 * the admin exists and its token is on disk, because that admin is what lets
 * every worker mint its own user over HTTP rather than writing rows.
 *
 * `src/config/env.ts` has already refused to load if DATABASE_URL is anything
 * but the local trading_journal_e2e, so the DELETE below cannot reach real data.
 */
export default async function globalSetup(): Promise<void> {
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
