import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

/**
 * Runs a Node CLI by spawning its entry point directly.
 *
 * Not `npx`, and not a shell. On Windows `npx` and `npm` are `.cmd` shims, and
 * since the fix for CVE-2024-27980 Node refuses to spawn a `.cmd` without
 * `shell: true` — which then warns, correctly, that arguments passed alongside
 * a shell are concatenated rather than escaped.
 *
 * Every tool these scripts need (Playwright, Prisma, tsx) is a JavaScript file
 * in `node_modules`, so the honest answer is to run `node <that file>`: no
 * shell, nothing to escape, no platform branch, and one less process in the
 * chain. The failure that led here was quiet — `npm run test:ratelimit` printed
 * its banner and then nothing, because the child never started and the error
 * sat unread on a result object.
 */
export function node(
  entry: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnSyncReturns<Buffer> {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: options.cwd,
    stdio: 'inherit',
    env: options.env ?? process.env,
  });

  if (result.error) {
    throw new Error(`Could not run ${path.basename(entry)}: ${result.error.message}`);
  }
  return result;
}

/** The same, but a non-zero exit throws. */
export function nodeOrThrow(
  entry: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const result = node(entry, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(entry)} ${args.join(' ')} exited ${result.status}` +
        (options.cwd ? ` (in ${options.cwd})` : ''),
    );
  }
}

/** Playwright's CLI, from this repository's own install. */
export function playwrightCli(): string {
  return require_.resolve('@playwright/test/cli');
}

/** tsx's CLI, used to run the API repository's TypeScript seed script. */
export function tsxCli(): string {
  return require_.resolve('tsx/cli');
}

/**
 * Prisma's CLI from a given repository's `node_modules`.
 *
 * Resolved from the API repository rather than this one: Prisma's generated
 * client, its engines and its schema all belong to that install, and a
 * different version here would be a different `db push`.
 */
export function prismaCli(repoRoot: string): string {
  return createRequire(path.join(repoRoot, 'package.json')).resolve('prisma/build/index.js');
}

/**
 * Runs a native executable on PATH — k6, which is a single Go binary rather
 * than a Node package.
 *
 * No shell needed: an `.exe` spawns directly on Windows. The `.cmd` problem
 * that `node()` exists to avoid applies only to npm's shims.
 */
export function binary(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnSyncReturns<Buffer> {
  return spawnSync(command, args, {
    cwd: options.cwd,
    stdio: 'inherit',
    env: options.env ?? process.env,
  });
}
