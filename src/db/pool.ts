import { Pool } from 'pg';
import { env } from '../config/env';

/**
 * One pool for the whole run.
 *
 * The suite reaches the database for three things only, all of them fixture
 * work the API genuinely cannot do: bootstrapping the first admin (every other
 * account is then minted over HTTP), resolving a new user's id (register does
 * not return one), and minting verification tokens (the raw token exists only
 * in an email — the row stores its SHA-256).
 *
 * Everything a test ASSERTS goes through the API or the UI. A test that checks
 * the database for the result of an action it performed through the product is
 * testing two things at once and reports the wrong one when it breaks.
 */
export const pool = new Pool({ connectionString: env.databaseUrl, max: 4 });

let closed = false;

/** Idempotent: global setup and global teardown both run in this process. */
export async function closePool(): Promise<void> {
  if (closed) return;
  closed = true;
  await pool.end();
}
