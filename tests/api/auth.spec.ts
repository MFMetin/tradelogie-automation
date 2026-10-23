import { test, expect } from '../../src/fixtures/base';
import { body, errorOf, retryAfterSeconds, newApiContext } from '../../src/api/client';
import type { LoginResponse } from '../../src/api/client';
import * as auth from '../../src/api/auth';
import type { RegisterResponse } from '../../src/api/auth';
import {
  createUnverifiedUser,
  createPremiumUser,
  uniqueEmail,
  uniqueUsername,
  DEFAULT_PASSWORD,
} from '../../src/fixtures/users';
import { mintToken, mintExpiredToken } from '../../src/db/tokens';
import { readLockState } from '../../src/db/users';

test.describe('POST /auth/register', () => {
  test('answers requires_verification and never a session', async ({ anonApi }) => {
    const email = uniqueEmail('reg');
    const response = await auth.register(anonApi, {
      email,
      password: DEFAULT_PASSWORD,
      username: uniqueUsername(),
    });

    expect(response.status()).toBe(201);
    const data = await body<RegisterResponse & Record<string, unknown>>(response);
    expect(data).toMatchObject({ requires_verification: true, email });

    // The point of the endpoint. Registration used to hand back tokens for an
    // address in ADMIN_EMAILS, which gave admin to whoever claimed it first.
    expect(data.access_token).toBeUndefined();
    expect(data.refresh_token).toBeUndefined();
    expect(data.user).toBeUndefined();
  });

  test('rejects a second account on the same email', async ({ anonApi }) => {
    const email = uniqueEmail('dup');
    const first = await auth.register(anonApi, {
      email,
      password: DEFAULT_PASSWORD,
      username: uniqueUsername(),
    });
    expect(first.status()).toBe(201);

    const second = await auth.register(anonApi, {
      email,
      password: DEFAULT_PASSWORD,
      username: uniqueUsername(),
    });
    expect(second.status()).toBe(409);
    expect((await errorOf(second)).message).toMatch(/already/i);
  });

  test('rejects a duplicate username', async ({ anonApi }) => {
    const username = uniqueUsername('taken');
    await auth.register(anonApi, {
      email: uniqueEmail('u1'),
      password: DEFAULT_PASSWORD,
      username,
    });

    const response = await auth.register(anonApi, {
      email: uniqueEmail('u2'),
      password: DEFAULT_PASSWORD,
      username,
    });
    expect(response.status()).toBe(409);
  });

  test('enforces the eight-character password floor', async ({ anonApi }) => {
    const response = await auth.register(anonApi, {
      email: uniqueEmail('short'),
      password: 'Short1!',
      username: uniqueUsername(),
    });
    expect(response.status()).toBe(400);
  });

  test('enforces the username character set', async ({ anonApi }) => {
    const response = await auth.register(anonApi, {
      email: uniqueEmail('badname'),
      password: DEFAULT_PASSWORD,
      username: 'not a username!',
    });
    expect(response.status()).toBe(400);
  });
});

test.describe('POST /auth/login', () => {
  test('refuses an unverified account with EMAIL_NOT_VERIFIED', async ({ anonApi }) => {
    const account = await createUnverifiedUser(anonApi);

    const response = await auth.login(anonApi, {
      email: account.email,
      password: account.password,
    });

    expect(response.status()).toBe(403);
    // The web client branches on this code to offer "resend" instead of
    // implying the password was wrong.
    expect((await errorOf(response)).code).toBe('EMAIL_NOT_VERIFIED');
  });

  test('answers a token pair and a sanitized user', async ({ anonApi }) => {
    const user = await createPremiumUser('login');

    const response = await auth.login(anonApi, { email: user.email, password: user.password });
    expect(response.ok()).toBeTruthy();

    const data = await body<LoginResponse & Record<string, unknown>>(response);
    expect(data.access_token).toBeTruthy();
    expect(data.refresh_token).toBeTruthy();
    expect(data.user_id).toBe(user.id);
    expect(data.user.email).toBe(user.email);
    expect(data.user.emailVerified).toBe(true);

    // Nothing from the row the client has no business seeing.
    const leaked = Object.keys(data.user).filter((key) => /password|hash|secret/i.test(key));
    expect(leaked, 'user payload leaked sensitive keys').toEqual([]);
  });

  test('does not enforce a password floor on login', async ({ anonApi }) => {
    // Accounts predate the eight-character minimum, so login validates
    // `min(1)` only. A 400 here would lock those people out of their own data.
    const response = await auth.login(anonApi, { email: uniqueEmail('nope'), password: 'x' });
    expect(response.status()).not.toBe(400);
    expect(response.status()).toBe(401);
  });

  test('locks the account after five wrong passwords @lockout', async ({ anonApi }) => {
    const user = await createPremiumUser('lock');

    const statuses: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await auth.login(anonApi, { email: user.email, password: 'Wr0ngPassw0rd!' });
      statuses.push(response.status());
    }
    // The first four are ordinary refusals; the fifth is what trips the lock.
    expect(statuses).toEqual([401, 401, 401, 401]);

    await auth.login(anonApi, { email: user.email, password: 'Wr0ngPassw0rd!' });

    const locked = await auth.login(anonApi, { email: user.email, password: 'Wr0ngPassw0rd!' });
    expect(locked.status()).toBe(429);
    expect((await errorOf(locked)).code).toBe('ACCOUNT_LOCKED');

    const wait = retryAfterSeconds(locked);
    expect(wait, 'ACCOUNT_LOCKED must say how long to wait').not.toBeNull();
    expect(wait).toBeGreaterThan(0);
    // First tier is five minutes.
    expect(wait).toBeLessThanOrEqual(5 * 60);

    const state = await readLockState(user.email);
    expect(state.failedLoginCount).toBeGreaterThanOrEqual(5);
    expect(state.lockedUntil).not.toBeNull();
  });

  test('refuses the CORRECT password while locked @lockout', async ({ anonApi }) => {
    const user = await createPremiumUser('lock2');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login(anonApi, { email: user.email, password: 'Wr0ngPassw0rd!' });
    }

    // The lock is checked before the password compare. Checked after, it would
    // tell a brute-forcer the moment it had guessed right.
    const response = await auth.login(anonApi, { email: user.email, password: user.password });
    expect(response.status()).toBe(429);
    expect((await errorOf(response)).code).toBe('ACCOUNT_LOCKED');
  });
});

test.describe('POST /auth/verify-email', () => {
  test('signs the user in directly on a valid token', async ({ anonApi }) => {
    const account = await createUnverifiedUser(anonApi, 'verify');
    const token = await mintToken(account.id, 'email_verify');

    const response = await auth.verifyEmail(anonApi, token);
    expect(response.ok()).toBeTruthy();

    const data = await body<LoginResponse>(response);
    expect(data.access_token).toBeTruthy();
    expect(data.user.emailVerified).toBe(true);
    expect(data.user.email).toBe(account.email);
  });

  test('refuses an expired token', async ({ anonApi }) => {
    const account = await createUnverifiedUser(anonApi, 'expired');
    const token = await mintExpiredToken(account.id, 'email_verify');

    const response = await auth.verifyEmail(anonApi, token);
    expect(response.ok()).toBeFalsy();
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('refuses a token that is merely well-formed', async ({ anonApi }) => {
    const response = await auth.verifyEmail(anonApi, 'a'.repeat(64));
    expect(response.ok()).toBeFalsy();
  });

  test('spends the token, so a second use fails', async ({ anonApi }) => {
    const account = await createUnverifiedUser(anonApi, 'once');
    const token = await mintToken(account.id, 'email_verify');

    expect((await auth.verifyEmail(anonApi, token)).ok()).toBeTruthy();
    expect((await auth.verifyEmail(anonApi, token)).ok()).toBeFalsy();
  });
});

test.describe('POST /auth/refresh', () => {
  test('rotates the pair and retires the old refresh token', async ({ anonApi }) => {
    const user = await createPremiumUser('refresh');

    const first = await auth.refresh(anonApi, user.refreshToken);
    expect(first.ok()).toBeTruthy();
    const rotated = await auth.tokensFrom(first);
    expect(rotated.refresh_token).not.toBe(user.refreshToken);
    expect(rotated.access_token).toBeTruthy();

    // Single use. This is why the web client funnels every 401 through one
    // shared in-flight refresh: two parallel ones race, and the loser is left
    // holding a token the server has already retired.
    const replay = await auth.refresh(anonApi, user.refreshToken);
    expect(replay.status()).toBe(401);
  });

  test('rejects a missing refresh token with 400, not 401', async ({ anonApi }) => {
    const response = await anonApi.post('auth/refresh', { data: {} });
    expect(response.status()).toBe(400);
  });

  test('revokes every session when a spent token is replayed', async ({ anonApi }) => {
    const user = await createPremiumUser('replay');

    const rotated = await auth.tokensFrom(await auth.refresh(anonApi, user.refreshToken));
    expect(rotated.refresh_token).toBeTruthy();

    // A signature that verifies against a row that is gone means the token was
    // already spent — the signature of a copy. The server cannot tell which of
    // the two holders is the real user, so it ends the whole family and makes
    // everyone sign in again. The thief's copy is worthless either way.
    const replay = await auth.refresh(anonApi, user.refreshToken);
    expect(replay.status()).toBe(401);

    // Collateral, and deliberately so: the session that did nothing wrong is
    // signed out too. Any test that replays a token has to expect this.
    const rotatedAfter = await auth.refresh(anonApi, rotated.refresh_token);
    expect(rotatedAfter.status()).toBe(401);
  });

  test('a random string cannot sign anyone out', async ({ anonApi }) => {
    const user = await createPremiumUser('nosig');

    // Reuse detection only fires once the SIGNATURE verifies. Were it checked
    // before, anyone could end a stranger's sessions by guessing nothing.
    expect((await auth.refresh(anonApi, 'not-a-token')).status()).toBe(401);
    expect((await auth.refresh(anonApi, user.refreshToken)).ok()).toBeTruthy();
  });
});

test.describe('POST /auth/logout', () => {
  test('retires the refresh token it is given', async ({ anonApi }) => {
    const user = await createPremiumUser('logout');

    expect((await auth.logout(anonApi, user.refreshToken)).ok()).toBeTruthy();
    expect((await auth.refresh(anonApi, user.refreshToken)).status()).toBe(401);
  });

  test('succeeds with no body at all', async ({ anonApi }) => {
    // Signing out must never fail: the client has already dropped the session
    // locally by the time it asks, so an error here only confuses.
    const response = await anonApi.post('auth/logout', { data: {} });
    expect(response.ok()).toBeTruthy();
  });
});

test.describe('account enumeration', () => {
  test('resend-verification answers the same for a stranger', async ({ anonApi }) => {
    const known = await createUnverifiedUser(anonApi, 'known');

    const forKnown = await auth.resendVerification(anonApi, known.email);
    const forStranger = await auth.resendVerification(anonApi, uniqueEmail('ghost'));

    expect(forKnown.status()).toBe(forStranger.status());
    expect(await forKnown.text()).toBe(await forStranger.text());
  });

  test('reset-password answers the same for a stranger', async ({ anonApi }) => {
    const user = await createPremiumUser('reset');

    const forKnown = await auth.requestPasswordReset(anonApi, user.email);
    const forStranger = await auth.requestPasswordReset(anonApi, uniqueEmail('ghost'));

    expect(forKnown.status()).toBe(forStranger.status());
    expect(await forKnown.text()).toBe(await forStranger.text());
  });
});

test.describe('password changes', () => {
  test('reset confirm sets the new password and clears the lock', async ({ anonApi }) => {
    const user = await createPremiumUser('resetpw');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login(anonApi, { email: user.email, password: 'Wr0ngPassw0rd!' });
    }
    expect((await readLockState(user.email)).lockedUntil).not.toBeNull();

    const token = await mintToken(user.id, 'password_reset');
    const newPassword = 'Rese7Passw0rd!';
    expect((await auth.confirmPasswordReset(anonApi, token, newPassword)).ok()).toBeTruthy();

    // Resetting is the documented way out of a lockout, so the counter has to
    // go with it — otherwise the reset link lands on a still-locked account.
    const after = await auth.login(anonApi, { email: user.email, password: newPassword });
    expect(after.ok()).toBeTruthy();
    expect((await readLockState(user.email)).failedLoginCount).toBe(0);
  });

  test('change-password answers a fresh pair and kills the old one', async ({ anonApi }) => {
    const user = await createPremiumUser('changepw');
    const asUser = await newApiContext(user.accessToken);

    try {
      const response = await auth.changePassword(asUser, {
        current_password: user.password,
        new_password: 'Changed1Passw0rd!',
      });
      expect(response.ok()).toBeTruthy();

      const fresh = await auth.tokensFrom(response);
      expect(fresh.access_token).toBeTruthy();
      expect(fresh.refresh_token).toBeTruthy();
      expect(fresh.refresh_token).not.toBe(user.refreshToken);

      // The fresh pair is checked FIRST, and that order is not cosmetic:
      // replaying the retired token below trips reuse detection, which revokes
      // the whole family — including this one. Asserted the other way round,
      // this test fails against a server that is behaving correctly.
      expect((await auth.refresh(anonApi, fresh.refresh_token)).ok()).toBeTruthy();

      // The server revoked every refresh token, this session's included. The
      // web client saves the new pair immediately for exactly this reason:
      // skip it and the next silent refresh 401s, signing the user out for
      // changing their own password.
      expect((await auth.refresh(anonApi, user.refreshToken)).status()).toBe(401);
    } finally {
      await asUser.dispose();
    }
  });

  test('change-password refuses a wrong current password', async ({ anonApi }) => {
    const user = await createPremiumUser('wrongcur');
    const asUser = await newApiContext(user.accessToken);

    try {
      const response = await auth.changePassword(asUser, {
        current_password: 'NotMyPassw0rd!',
        new_password: 'Whatever1Passw0rd!',
      });
      expect(response.status()).toBe(401);
      expect((await errorOf(response)).code).toBe('INVALID_PASSWORD');

      // Still the old password.
      expect(
        (await auth.login(anonApi, { email: user.email, password: user.password })).ok(),
      ).toBeTruthy();
    } finally {
      await asUser.dispose();
    }
  });
});
