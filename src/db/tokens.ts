import crypto from 'node:crypto';
import { pool } from './pool';

export type TokenType = 'email_verify' | 'password_reset';

/**
 * Prisma maps DateTime to `timestamp(3)` WITHOUT time zone, and reads every
 * value back as UTC. node-postgres, handed a JS Date, serialises it with this
 * machine's offset — which Postgres then discards for such a column. So on a
 * UTC+3 machine a row written as a Date lands three hours ahead of where it was
 * meant to, and an expiry one minute in the past reads as one two hours and
 * fifty-nine minutes in the future.
 *
 * That is not hypothetical: it is why the expired-token test first passed.
 * Writing the UTC wall clock with no offset is what Prisma itself does, so the
 * fixture and the application agree about what a timestamp means.
 */
function utcTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '');
}

/**
 * Produces a working verification link without an inbox.
 *
 * The backend generates 32 random bytes, stores `sha256(token)` and returns the
 * raw value exactly once — into an email body. So the link cannot be recovered
 * from the database, and the only other way to read it is to scrape the dev
 * server's stdout for the "RESEND_API_KEY not set" log line, which is both
 * fragile and unavailable to a test when Playwright owns the process.
 *
 * Minting the pair here instead is deterministic: we write the hash the server
 * will look up and keep the raw token for the URL. It reproduces exactly what
 * the user receives, and it is the same one-way function either way — nothing
 * is being bypassed, only the mail hop.
 *
 * The server deletes any prior token of the same type for the user before
 * issuing one, so this does too.
 */
export async function mintToken(
  userId: string,
  type: TokenType,
  options: { expiresInMs?: number } = {},
): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  const ttl = options.expiresInMs ?? 24 * 60 * 60 * 1000;

  await pool.query('DELETE FROM verification_tokens WHERE user_id = $1 AND type = $2', [
    userId,
    type,
  ]);
  await pool.query(
    `INSERT INTO verification_tokens (id, user_id, token, type, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), userId, hashed, type, utcTimestamp(Date.now() + ttl)],
  );

  return raw;
}

/**
 * The same thing, already expired. Used by the test that checks an expired
 * link is refused rather than silently accepted.
 */
export function mintExpiredToken(userId: string, type: TokenType): Promise<string> {
  return mintToken(userId, type, { expiresInMs: -60 * 1000 });
}

/**
 * Clears the DB-backed send cooldown, which is deliberately immune to a server
 * restart because it is a row's `created_at` rather than a memory bucket
 * (auth.service `emailSentRecently`). A resend test has to move it out of the
 * way or it answers the cooldown instead of the thing under test.
 */
export async function clearEmailCooldown(userId: string): Promise<void> {
  await pool.query('DELETE FROM verification_tokens WHERE user_id = $1', [userId]);
}
