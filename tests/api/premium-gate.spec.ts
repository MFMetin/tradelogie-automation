import { test, expect } from '../../src/fixtures/base';
import { body, errorOf, newApiContext } from '../../src/api/client';
import type { ApiUser } from '../../src/api/client';
import { activateMock } from '../../src/api/billing';
import { setPremium, setRole } from '../../src/api/admin';
import { createVerifiedUser } from '../../src/fixtures/users';
import { readAdminState } from '../../src/fixtures/globalSetup';

/**
 * Every premium-gated mount, from app.ts. Listed rather than sampled: the gate
 * is applied per router, so a new feature mounted without `requirePremium` is
 * exactly the regression this file exists to catch — and a spot check of two
 * of them would not.
 */
const GATED = [
  'trades',
  'import-profiles',
  'lessons/paths',
  'achievements',
  'leaderboard',
  'connected-accounts',
] as const;

/**
 * Reachable with a session alone. `users/me` especially: a user who cannot
 * read their own profile cannot be shown why they are stuck behind the paywall,
 * so gating it would make the gate unexplainable.
 */
const UNGATED = ['users/me'] as const;

test.describe('requirePremium', () => {
  test('turns a verified non-premium user away from every gated mount', async () => {
    const user = await createVerifiedUser('gated');
    const api = await newApiContext(user.accessToken);

    try {
      for (const path of GATED) {
        const response = await api.get(path);
        expect(response.status(), `GET ${path} should be gated`).toBe(403);
        expect((await errorOf(response)).code, `GET ${path} code`).toBe('PREMIUM_REQUIRED');
      }
    } finally {
      await api.dispose();
    }
  });

  test('leaves the paywall and the profile reachable', async () => {
    const user = await createVerifiedUser('ungated');
    const api = await newApiContext(user.accessToken);

    try {
      for (const path of UNGATED) {
        const response = await api.get(path);
        // Whatever it answers, it must not be the premium refusal — a user who
        // cannot read their own profile cannot be told why they are stuck.
        expect((await errorOf(response)).code, `GET ${path}`).not.toBe('PREMIUM_REQUIRED');
      }
      expect((await api.get('users/me')).ok()).toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  test('mock billing lets a user open the gate themselves', async () => {
    const user = await createVerifiedUser('mock');
    const api = await newApiContext(user.accessToken);

    try {
      expect((await api.get('trades')).status()).toBe(403);

      // requireAuth only — no premium check, no admin. This is the paywall's
      // test door, and ENABLE_MOCK_BILLING defaults to on.
      const activated = await activateMock(api, 30);
      expect(activated.ok()).toBeTruthy();
      const result = await body<{ isPremium: boolean; premiumUntil: string }>(activated);
      expect(result.isPremium).toBe(true);
      expect(new Date(result.premiumUntil).getTime()).toBeGreaterThan(Date.now());

      expect((await api.get('trades')).ok()).toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  test('clamps the mock grant to a year', async () => {
    const user = await createVerifiedUser('clamp');
    const api = await newApiContext(user.accessToken);

    try {
      const response = await activateMock(api, 99_999);
      expect(response.ok()).toBeTruthy();
      const { premiumUntil } = await body<{ premiumUntil: string }>(response);

      const days = (new Date(premiumUntil).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeLessThanOrEqual(366);
      expect(days).toBeGreaterThan(364);
    } finally {
      await api.dispose();
    }
  });

  test('an expired premiumUntil is not premium', async ({ adminApi }) => {
    const user = await createVerifiedUser('expired');
    const api = await newApiContext(user.accessToken);

    try {
      // Granted, then backdated. `requirePremium` reads the flag AND the date;
      // trusting the flag alone would let every lapsed subscriber back in.
      expect((await setPremium(adminApi, user.id, { isPremium: true, days: 1 })).ok()).toBeTruthy();
      expect((await api.get('trades')).ok()).toBeTruthy();

      await expirePremium(user.id);

      const response = await api.get('trades');
      expect(response.status()).toBe(403);
      expect((await errorOf(response)).code).toBe('PREMIUM_REQUIRED');
    } finally {
      await api.dispose();
    }
  });

  test('an admin is premium without ever being granted it', async ({ adminApi }) => {
    const user = await createVerifiedUser('toadmin');
    const api = await newApiContext(user.accessToken);

    try {
      expect((await api.get('trades')).status()).toBe(403);

      expect((await setRole(adminApi, user.id, 'admin')).ok()).toBeTruthy();

      // `role === 'admin'` short-circuits the whole check, so isPremium stays
      // false and the gate opens anyway. Support needs to see what a paying
      // customer sees without buying a subscription to do it.
      const profile = await body<ApiUser>(await api.get('users/me'));
      expect(profile.role).toBe('admin');
      expect(profile.isPremium).toBe(false);

      expect((await api.get('trades')).ok()).toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  test('the gate is a server check, not a client one', async () => {
    const user = await createVerifiedUser('forged');
    const api = await newApiContext(user.accessToken);

    try {
      // The web client's PremiumGate reads the cached profile, so editing
      // localStorage gets you the route. It must get you nothing else: every
      // request is re-gated, which is what makes that cache harmless.
      expect((await api.get('trades')).status()).toBe(403);
      expect((await api.post('trades', { data: { symbol: 'BTCUSDT' } })).status()).toBe(403);
    } finally {
      await api.dispose();
    }
  });

  test('no token at all is 401, not 403', async ({ anonApi }) => {
    // The distinction matters to the client: 401 means refresh and retry,
    // 403 PREMIUM_REQUIRED means send them to /billing.
    const response = await anonApi.get('trades');
    expect(response.status()).toBe(401);
    expect((await errorOf(response)).code).not.toBe('PREMIUM_REQUIRED');
  });
});

/**
 * Backdates an active subscription. There is no endpoint for this — the admin
 * panel can only grant — and the test needs a lapsed one.
 */
async function expirePremium(userId: string): Promise<void> {
  const { pool } = await import('../../src/db/pool');
  await pool.query(
    "UPDATE users SET premium_until = now() - interval '1 day' WHERE id = $1",
    [userId],
  );
}

test.describe('admin gate', () => {
  test('a non-admin cannot reach the admin surface', async () => {
    const user = await createVerifiedUser('notadmin');
    const api = await newApiContext(user.accessToken);

    try {
      for (const path of ['admin/stats', 'admin/users', 'admin/audit']) {
        expect((await api.get(path)).status(), `GET ${path}`).toBe(403);
      }
    } finally {
      await api.dispose();
    }
  });

  test('the bootstrap admin can', async ({ adminApi }) => {
    expect((await adminApi.get('admin/stats')).ok()).toBeTruthy();
    expect((await adminApi.get('admin/users')).ok()).toBeTruthy();
  });

  test('admin state on disk belongs to an actual admin', async ({ adminApi }) => {
    // Cheap, and it fails loudly rather than letting every user fixture in the
    // suite fail one at a time with "verify failed".
    const profile = await body<ApiUser>(await adminApi.get('users/me'));
    expect(profile.email).toBe(readAdminState().email);
    expect(profile.role).toBe('admin');
  });
});
