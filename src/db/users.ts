import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from './pool';
import { env } from '../config/env';

/** Matches the backend's own cost factor (auth.service.ts). */
const BCRYPT_ROUNDS = 12;

export interface SeededUser {
  id: string;
  email: string;
  password: string;
}

/**
 * Writes a ready-to-use account straight into the table.
 *
 * Used once, for the admin that bootstraps everything else. It exists because
 * the product has no way to produce a verified account without an inbox:
 * registration always answers `requires_verification`, the link is only ever
 * emailed, and the row stores the token's hash rather than the token.
 *
 * `email_verified` is not passed: the column defaults to true in the schema
 * (it was added that way so a deploy would not lock out existing rows), and
 * only `register` sets it false. An insert that skips it is verified.
 *
 * `role: 'admin'` is what makes this account enough on its own — requirePremium
 * passes unconditionally for an admin, so the bootstrap needs no billing call.
 */
export async function insertAdminUser(email: string, password: string): Promise<SeededUser> {
  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  await pool.query(
    `INSERT INTO users (id, email, username, password_hash, display_name, role, is_premium)
     VALUES ($1, $2, $3, $4, $5, 'admin', true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = 'admin',
           is_premium = true,
           email_verified = true,
           banned_at = NULL,
           failed_login_count = 0,
           locked_until = NULL`,
    [id, email, `e2eadmin${Date.now().toString(36)}`, hash, 'E2E Admin'],
  );

  const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    email,
  ]);
  const row = rows[0];
  if (!row) throw new Error(`Admin user ${email} missing right after insert`);
  return { id: row.id, email, password };
}

/**
 * `POST /auth/register` answers `{ requires_verification, email }` and no id,
 * so the admin endpoints that verify and grant premium have nothing to address.
 * This is the one lookup that fills that gap.
 */
export async function findUserIdByEmail(email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    email,
  ]);
  const row = rows[0];
  if (!row) throw new Error(`No user row for ${email}`);
  return row.id;
}

/**
 * Removes every account this suite has ever created, and with it (ON DELETE
 * CASCADE) their trades, tokens, progress and connected accounts.
 *
 * Scoped to the reserved domain rather than truncating the table: the database
 * is a throwaway, but it also holds the seeded lesson and achievement content,
 * and a developer may have a hand-made account in there worth keeping.
 */
export async function deleteAllTestUsers(): Promise<number> {
  const { rowCount } = await pool.query('DELETE FROM users WHERE email LIKE $1', [
    `%${env.testEmailDomain}`,
  ]);
  return rowCount ?? 0;
}

export async function deleteUserByEmail(email: string): Promise<void> {
  await pool.query('DELETE FROM users WHERE email = $1', [email]);
}

/** Reads back the two lockout columns, for the tests that assert on them. */
export async function readLockState(
  email: string,
): Promise<{ failedLoginCount: number; lockedUntil: Date | null }> {
  const { rows } = await pool.query<{ failed_login_count: number; locked_until: Date | null }>(
    'SELECT failed_login_count, locked_until FROM users WHERE email = $1',
    [email],
  );
  const row = rows[0];
  if (!row) throw new Error(`No user row for ${email}`);
  return { failedLoginCount: row.failed_login_count, lockedUntil: row.locked_until };
}
