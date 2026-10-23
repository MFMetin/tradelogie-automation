import fs from 'node:fs';
import path from 'node:path';
import { env, REPO_ROOT } from '../config/env';
import { newApiContext } from '../api/client';
import { loginOrThrow } from '../api/auth';
import { insertAdminUser } from '../db/users';

export const ADMIN_STATE = path.join(REPO_ROOT, '.auth', 'admin.json');

export interface AdminState {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Makes sure the bootstrap admin exists and its token is on disk.
 *
 * Lives here rather than inside Playwright's global setup because it is not
 * only Playwright that needs it. `scripts/run-k6.ts` mints an account too, and
 * it depended on the state file having been written by a test run that it never
 * starts — so the k6 job failed with "Admin state missing — did global setup
 * run?", which is an honest question with an unhelpful answer. Anything that
 * needs an account calls this first now.
 *
 * Idempotent: the insert upserts, and a second call just re-logs in.
 */
export async function ensureAdmin(): Promise<AdminState> {
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

    const state: AdminState = {
      id: session.user_id,
      email: admin.email,
      password: admin.password,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    };

    fs.mkdirSync(path.dirname(ADMIN_STATE), { recursive: true });
    fs.writeFileSync(
      ADMIN_STATE,
      JSON.stringify({ ...state, user: session.user }, null, 2),
    );

    return state;
  } finally {
    await api.dispose();
  }
}

export function readAdminState(): AdminState {
  if (!fs.existsSync(ADMIN_STATE)) {
    throw new Error(
      `Admin state missing at ${ADMIN_STATE}.\n` +
        '  A test run writes it in global setup. A script that needs an account ' +
        'outside a test run should call ensureAdmin() first.',
    );
  }
  return JSON.parse(fs.readFileSync(ADMIN_STATE, 'utf8')) as AdminState;
}
