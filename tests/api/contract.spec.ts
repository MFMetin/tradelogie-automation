import { test, expect } from '../../src/fixtures/base';
import { body, errorOf, newApiContext } from '../../src/api/client';
import { createPremiumUser } from '../../src/fixtures/users';
import { aTrade } from '../../src/fixtures/data';
import * as trades from '../../src/api/trades';
import { env } from '../../src/config/env';

/**
 * The shape of the API, as distinct from its behaviour.
 *
 * Everything the web client's `lib/api.ts` assumes lives here: raw JSON with no
 * envelope, errors as `{ message, code? }`, and a `code` to branch on rather
 * than a message to match. Those assumptions are spread across some thirty call
 * sites in the client and none of them would say so when they broke.
 */
test.describe('response envelope', () => {
  test('successful bodies are the payload itself', async ({ userApi }) => {
    const created = await body<Record<string, unknown>>(
      await trades.createTrade(userApi, aTrade()),
    );

    // Not `{ data: ... }`. The client reads `response.data.id`, so an envelope
    // added later would make every field read `undefined` rather than throw.
    expect(created.data).toBeUndefined();
    expect(created.id).toBeTruthy();
    expect(created.symbol).toBe('BTCUSDT');
  });

  test('a collection is a bare array', async ({ userApi }) => {
    await trades.createTrade(userApi, aTrade());
    const listed = await body<unknown>(await trades.listTrades(userApi, { limit: 1 }));
    expect(Array.isArray(listed)).toBe(true);
  });

  test('the profile is a bare object', async ({ userApi }) => {
    const profile = await body<Record<string, unknown>>(await userApi.get('users/me'));
    expect(profile.data).toBeUndefined();
    expect(profile.id).toBeTruthy();
    expect(profile.email).toBeTruthy();
  });
});

test.describe('error shape', () => {
  test('a validation failure carries a message', async ({ userApi }) => {
    const response = await trades.createTrade(userApi, { symbol: '' });
    expect(response.status()).toBe(400);

    const error = await errorOf(response);
    // `apiErrorMessage()` extracts exactly this, and falls back to a generic
    // sentence when it is missing — which is what the user then sees.
    expect(typeof error.message).toBe('string');
    expect(error.message!.length).toBeGreaterThan(0);
  });

  test('every branded refusal carries a machine-readable code', async ({ anonApi }) => {
    const free = await createPremiumUser('codes');

    // The codes the web client actually branches on. A rename here changes
    // which screen the user lands on, silently.
    const premiumless = await newApiContext(
      (await createVerifiedOnly()).accessToken,
    );
    try {
      expect((await errorOf(await premiumless.get('trades'))).code).toBe('PREMIUM_REQUIRED');
    } finally {
      await premiumless.dispose();
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await anonApi.post('auth/login', {
        data: { email: free.email, password: 'Wr0ngPassw0rd!' },
      });
    }
    const locked = await anonApi.post('auth/login', {
      data: { email: free.email, password: free.password },
    });
    expect((await errorOf(locked)).code).toBe('ACCOUNT_LOCKED');
  });

  test('404 is JSON, not an HTML error page', async ({ anonApi }) => {
    const response = await anonApi.get('definitely-not-an-endpoint');
    expect(response.status()).toBe(404);
    // Express's default handler answers HTML. Anything the client might parse
    // as a message has to be JSON, or `apiErrorMessage` shows markup.
    expect(response.headers()['content-type']).toContain('application/json');
  });
});

test.describe('headers', () => {
  test('the API is reachable without an Origin at all', async ({ anonApi }) => {
    // The CORS callback is `!origin || allowed.includes(origin)`, so a tool
    // with no Origin header — this suite included — is always allowed.
    expect((await anonApi.get('../../health')).ok()).toBeTruthy();
  });

  test('the browser origin the suite serves is allowed', async () => {
    const api = await newApiContext();
    try {
      const response = await api.get('users/me', {
        headers: { Origin: env.baseURL },
      });
      // 401 is the expected answer with no token; what matters is that the
      // origin was not refused. ALLOWED_ORIGINS has to name the port the built
      // bundle is served from, or every API call the app makes is blocked.
      expect(response.headers()['access-control-allow-origin']).toBe(env.baseURL);
    } finally {
      await api.dispose();
    }
  });

  test('a request without X-Timezone still works', async () => {
    const user = await createPremiumUser('notz');
    const api = await newApiContext();
    try {
      const response = await api.get('users/me', {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      // The header moves the day boundary for the streak; dropping it has to
      // fall back rather than fail, because a non-browser client has no zone.
      expect(response.ok()).toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  test('a malformed body is a 400, not a 500', async ({ anonApi }) => {
    const response = await anonApi.post('auth/login', {
      headers: { 'Content-Type': 'application/json' },
      data: '{ not json',
    });
    expect(response.status()).toBe(400);
  });
});

/** Verified but not premium, without pulling in the whole fixture module. */
async function createVerifiedOnly() {
  const { createVerifiedUser } = await import('../../src/fixtures/users');
  return createVerifiedUser('contract');
}
