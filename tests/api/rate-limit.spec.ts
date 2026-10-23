import { test, expect } from '../../src/fixtures/base';
import { errorOf, retryAfterSeconds } from '../../src/api/client';
import * as auth from '../../src/api/auth';
import { createPremiumUser, uniqueEmail } from '../../src/fixtures/users';

/**
 * The limiters, which the rest of the suite runs without.
 *
 * `DISABLE_RATE_LIMIT` turns every one of them into a passthrough for the main
 * run: a parallel UI suite spends more than 120 requests a minute just loading
 * pages, and would otherwise spend its time proving it had been throttled. That
 * would leave a security control untested, so it gets its own configuration —
 * a second backend on its own port, started with the limiters on, and nothing
 * else running against it.
 *
 *     npm run test:ratelimit
 *
 * Three things make this file different from every other one here, and all
 * three are forced by what is under test:
 *
 * 1. **Serial, one worker.** The buckets are per-IP and in memory, so two
 *    workers would spend each other's budget and neither assertion would mean
 *    anything.
 *
 * 2. **Order matters, and the order is the file's order.** `globalLimiter` is
 *    120/min across the WHOLE API, so every request any test here makes also
 *    counts against it. The cheap tests therefore run first, and the one that
 *    exhausts the global budget runs last.
 *
 * 3. **Each limiter is identified by WHEN it fires, not by its code.** Every
 *    limiter answers 429 with `code: 'RATE_LIMITED'`, so the code alone cannot
 *    tell you which one you hit. The counts can: 5 for email, 10 for auth
 *    failures, 120 for everything. An earlier-than-expected 429 means the
 *    global ceiling got there first, and that is reported as a failure rather
 *    than quietly passing — which is what an assertion on the code alone did
 *    when this file was first written.
 */
const limitersAreOff = process.env.DISABLE_RATE_LIMIT === 'true';

test.describe.configure({ mode: 'serial' });

/**
 * Sends `attempts` requests and reports the index of the first 429.
 * `null` means it never fired.
 */
async function firstRefusalAt(
  attempts: number,
  send: (index: number) => Promise<{ status: number; code?: string; retryAfter: number | null }>,
): Promise<{ index: number | null; code?: string; retryAfter: number | null }> {
  for (let index = 0; index < attempts; index += 1) {
    const result = await send(index);
    if (result.status === 429) {
      return { index, code: result.code, retryAfter: result.retryAfter };
    }
  }
  return { index: null, retryAfter: null };
}

test.describe('emailLimiter — 5 per hour, per address-naming sender', () => {
  test.skip(limitersAreOff, 'run with `npm run test:ratelimit`');

  test('refuses the sixth send', async ({ anonApi }) => {
    // First in the file on purpose: the hour-long window cannot be reset
    // without restarting the process, and only ~6 requests of the global
    // minute budget have been spent at this point.
    const outcome = await firstRefusalAt(8, async (index) => {
      const response = await auth.resendVerification(anonApi, uniqueEmail(`mail${index}`));
      return {
        status: response.status(),
        code: (await errorOf(response)).code,
        retryAfter: retryAfterSeconds(response),
      };
    });

    expect(outcome.index, 'emailLimiter never fired within 8 sends').not.toBeNull();
    // Exactly the sixth. Earlier would mean something else refused it.
    expect(outcome.index, 'a 429 before the sixth send is a different limiter').toBe(5);
    expect(outcome.code).toBe('RATE_LIMITED');
    expect(outcome.retryAfter).not.toBeNull();
  });
});

test.describe('authLimiter — 10 failures per 15 minutes', () => {
  test.skip(limitersAreOff, 'run with `npm run test:ratelimit`');

  test('does not count successful logins', async ({ anonApi }) => {
    const user = await createPremiumUser('rl-ok');

    // `skipSuccessfulRequests`. Someone who simply signs in a lot is never
    // punished for it, while a brute-forcer produces nothing but failures and
    // so meets the ceiling exactly as hard. Twelve is past the limit of ten.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await auth.login(anonApi, { email: user.email, password: user.password });
      expect(response.ok(), `successful login ${attempt + 1} was limited`).toBeTruthy();
    }
  });

  test('refuses the eleventh failure', async ({ anonApi }) => {
    // A different address every time, so the per-ACCOUNT lockout (5 failures
    // on ONE account) can never be what fires. What is left is the per-IP
    // limiter, which is the thing under test.
    const outcome = await firstRefusalAt(13, async (index) => {
      const response = await auth.login(anonApi, {
        email: uniqueEmail(`rl${index}`),
        password: 'Wr0ngPassw0rd!',
      });
      return {
        status: response.status(),
        code: (await errorOf(response)).code,
        retryAfter: retryAfterSeconds(response),
      };
    });

    expect(outcome.index, 'authLimiter never fired within 13 failures').not.toBeNull();
    expect(outcome.index, 'a 429 before the eleventh failure is a different limiter').toBe(10);
    // RATE_LIMITED and not ACCOUNT_LOCKED. Both are 429s and the web client
    // treats them completely differently — one is "everyone wait", the other
    // is "this account is sitting out a lockout".
    expect(outcome.code).toBe('RATE_LIMITED');
  });
});

test.describe('globalLimiter — 120 per minute across the API', () => {
  test.skip(limitersAreOff, 'run with `npm run test:ratelimit`');

  test('leaves /health outside the ceiling', async ({ anonApi }) => {
    // Railway polls it. Inside the limiter, a request flood would take the
    // health check down with it and the platform would recycle the container
    // in the middle of the incident.
    expect((await anonApi.get('../../health')).ok()).toBeTruthy();
  });

  test('advertises the policy it enforces', async ({ anonApi }) => {
    const response = await anonApi.get('users/me');
    const headers = response.headers();

    // `standardHeaders: true`, which is what makes the test below possible
    // without a sixty-second wait, and what lets a well-behaved client pace
    // itself instead of discovering the ceiling by hitting it.
    expect(headers['ratelimit-policy']).toBe('120;w=60');
    expect(headers['ratelimit-limit']).toBe('120');
    expect(Number(headers['ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
    expect(Number(headers['ratelimit-reset'])).toBeGreaterThan(0);
  });

  test('refuses the request after the budget it reported runs out', async ({ anonApi }) => {
    // Measuring this as "the 121st request fails" does not work here: the
    // window is a minute, it is shared with every other test in this file, and
    // by the time this one runs most of it is gone. Waiting it out would mean a
    // blind sixty-second sleep.
    //
    // So the limiter is asked how much is left instead. That turns a brittle
    // count into an exact assertion AND checks that the advertised budget is
    // the one actually enforced — a header that lied would be worse than no
    // header, because a client paces itself by it.
    const probe = await anonApi.get('users/me');
    const remaining = Number(probe.headers()['ratelimit-remaining']);
    expect(Number.isFinite(remaining), 'no RateLimit-Remaining to work from').toBe(true);

    for (let spent = 0; spent < remaining; spent += 1) {
      const response = await anonApi.get('users/me');
      expect(
        response.status(),
        `refused after ${spent} of ${remaining} remaining requests`,
      ).not.toBe(429);
    }

    const over = await anonApi.get('users/me');
    expect(over.status()).toBe(429);
    expect((await errorOf(over)).code).toBe('RATE_LIMITED');
    // A wait, not a refusal: the client sits it out rather than treating it as
    // a dead session. The CSV wizard resends the same chunk on this basis.
    expect(retryAfterSeconds(over)).not.toBeNull();
    expect(over.headers()['ratelimit-remaining']).toBe('0');
  });
});
