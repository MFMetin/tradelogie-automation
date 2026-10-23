import crypto from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { env } from '../config/env';
import { newApiContext, body, type ApiUser, type LoginResponse } from '../api/client';
import { register, loginOrThrow } from '../api/auth';
import { verifyUserEmail, setPremium } from '../api/admin';
import { findUserIdByEmail } from '../db/users';
import { readAdminState } from './globalSetup';

export interface TestUser {
  id: string;
  email: string;
  username: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  user: ApiUser;
}

/** Unique per call, and always inside the domain teardown sweeps. */
export function uniqueEmail(prefix: string): string {
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${suffix}${env.testEmailDomain}`;
}

export function uniqueUsername(prefix = 'e2e'): string {
  // The server enforces `^[a-zA-Z0-9_]+$`, 3–30 characters.
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

export const DEFAULT_PASSWORD = 'E2ePassw0rd!';

/**
 * Registers an account and leaves it exactly as the product does: unverified,
 * no tokens, nothing granted. This is the starting state the auth UI tests
 * need — they are testing the road from here.
 */
export async function createUnverifiedUser(
  api: APIRequestContext,
  prefix = 'unverified',
): Promise<{ id: string; email: string; username: string; password: string }> {
  const email = uniqueEmail(prefix);
  const username = uniqueUsername();
  const response = await register(api, { email, password: DEFAULT_PASSWORD, username });
  if (!response.ok()) {
    throw new Error(`Register failed for ${email}: ${response.status()} ${await response.text()}`);
  }
  // Register answers `{ requires_verification, email }` and no id, so the
  // admin endpoints have nothing to address until we look it up.
  const id = await findUserIdByEmail(email);
  return { id, email, username, password: DEFAULT_PASSWORD };
}

/**
 * The full fixture account: registered, verified, premium, signed in.
 *
 * Built out of three product endpoints rather than an INSERT, so the path a
 * real support agent would take is covered by every run that needs a user.
 * Premium is `lifetime` — a day count would make the account's validity a
 * function of how long the suite takes.
 */
export async function createPremiumUser(prefix = 'user'): Promise<TestUser> {
  const admin = readAdminState();
  const anon = await newApiContext();
  const asAdmin = await newApiContext(admin.accessToken);

  try {
    const account = await createUnverifiedUser(anon, prefix);

    const verified = await verifyUserEmail(asAdmin, account.id);
    if (!verified.ok()) {
      throw new Error(`Admin verify failed: ${verified.status()} ${await verified.text()}`);
    }

    const granted = await setPremium(asAdmin, account.id, { isPremium: true, lifetime: true });
    if (!granted.ok()) {
      throw new Error(`Admin premium grant failed: ${granted.status()} ${await granted.text()}`);
    }

    const session = await loginOrThrow(anon, account.email, account.password);
    return {
      id: account.id,
      email: account.email,
      username: account.username,
      password: account.password,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      user: session.user,
    };
  } finally {
    await anon.dispose();
    await asAdmin.dispose();
  }
}

/**
 * Verified but NOT premium — the state the paywall exists for. Used by the
 * premium-gate tests, which are the only ones that want to be turned away.
 */
export async function createVerifiedUser(prefix = 'free'): Promise<TestUser> {
  const admin = readAdminState();
  const anon = await newApiContext();
  const asAdmin = await newApiContext(admin.accessToken);

  try {
    const account = await createUnverifiedUser(anon, prefix);
    const verified = await verifyUserEmail(asAdmin, account.id);
    if (!verified.ok()) {
      throw new Error(`Admin verify failed: ${verified.status()} ${await verified.text()}`);
    }
    const session = await loginOrThrow(anon, account.email, account.password);
    return {
      id: account.id,
      email: account.email,
      username: account.username,
      password: account.password,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      user: session.user,
    };
  } finally {
    await anon.dispose();
    await asAdmin.dispose();
  }
}

export async function refreshProfile(token: string): Promise<ApiUser> {
  const api = await newApiContext(token);
  try {
    const response = await api.get('users/me');
    if (!response.ok()) throw new Error(`GET /users/me failed: ${response.status()}`);
    return body<ApiUser>(response);
  } finally {
    await api.dispose();
  }
}

export type { LoginResponse };
