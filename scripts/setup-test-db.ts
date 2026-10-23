import { Client } from 'pg';
import { env } from '../src/config/env';
import { nodeOrThrow, prismaCli, tsxCli } from './spawn';

/**
 * Creates the suite's own database and fills it with the content the tests need.
 *
 * A database of its own, not the development one, for two reasons that both
 * came up for real on this project:
 *
 *   - The suite DELETEs user rows. `src/config/env.ts` refuses to load against
 *     anything but `trading_journal_e2e` on localhost, and this script is what
 *     makes that database exist so the guard is never in anyone's way.
 *   - The development database here had drifted from `schema.prisma` — missing
 *     the two account-lockout columns, carrying four it wanted to drop — so
 *     `prisma db push` would not run against it without `--accept-data-loss`,
 *     and the lockout tests would have silently measured nothing. A database
 *     created from the schema has no drift by definition.
 *
 * Idempotent: safe to run again. The content seed is the one part that is not,
 * so it is skipped when the content is already there.
 *
 *     npm run db:setup
 */
async function main(): Promise<void> {
  const target = new URL(env.databaseUrl);
  const name = target.pathname.replace(/^\//, '');

  // CREATE DATABASE cannot run inside the database it creates, so this connects
  // to `postgres` with the same credentials.
  const admin = new URL(env.databaseUrl);
  admin.pathname = '/postgres';

  const client = new Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Could not reach Postgres at ${target.host}: ${(error as Error).message}\n` +
        'Check that it is running and that DATABASE_URL in .env has the right password.',
    );
  }

  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.rowCount) {
      console.log(`· ${name} already exists`);
    } else {
      // The name comes from the parsed URL and has already been checked against
      // an exact literal by the env guard, so it cannot be anything else here.
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      console.log(`✓ created ${name}`);
    }
  } finally {
    await client.end();
  }

  console.log('· applying prisma/schema.prisma');
  // No `--skip-generate`: this Prisma version does not accept the flag and
  // prints its help text instead of pushing, which reads as success.
  nodeOrThrow(prismaCli(env.apiRepo), ['db', 'push'], {
    cwd: env.apiRepo,
    env: withDbUrl(),
  });

  // `prisma/seed.ts` uses `create`, not `upsert`, so running it twice duplicates
  // every lesson and achievement. The quiz tests read the answer key out of
  // those rows, so the suite needs them exactly once.
  const seeded = await alreadySeeded();
  if (seeded) {
    console.log('· content already seeded (quizzes present), skipping');
  } else {
    console.log('· seeding lesson, quiz and achievement content');
    // The API's own `db:seed` script is `tsx prisma/seed.ts`; running tsx
    // directly skips the npm shim, which is the part Windows cannot spawn.
    nodeOrThrow(tsxCli(), ['prisma/seed.ts'], { cwd: env.apiRepo, env: withDbUrl() });
  }

  console.log(`\nReady. ${name} is set up; run \`npm test\`.`);
}

/**
 * The API's own .env would otherwise win: `prisma.config.ts` loads dotenv,
 * which does not override an existing variable — so this has to be set in the
 * child's environment rather than left to the file.
 */
function withDbUrl(): NodeJS.ProcessEnv {
  return { ...process.env, DATABASE_URL: env.databaseUrl };
}

async function alreadySeeded(): Promise<boolean> {
  const client = new Client({ connectionString: env.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ count: string }>('SELECT count(*) FROM quizzes');
    return Number(rows[0]?.count ?? 0) > 0;
  } catch {
    // No table yet means nothing has been seeded.
    return false;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
