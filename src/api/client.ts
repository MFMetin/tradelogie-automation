import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { env } from '../config/env';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

export interface ApiUser {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  role: string;
  isPremium: boolean;
  premiumUntil: string | null;
  emailVerified: boolean;
  xp: number;
  level: number;
  streakDays: number;
}

export interface LoginResponse extends TokenPair {
  user_id: string;
  user: ApiUser;
}

/**
 * The API answers with bare JSON and no envelope, and errors as
 * `{ message, code? }`. Shaped here so a test can branch on `code` — which is
 * what the product's own client does — rather than matching message strings
 * that are localised, or rewritten by the rate-limit formatter.
 */
export interface ApiError {
  message?: string;
  code?: string;
}

export async function newApiContext(token?: string): Promise<APIRequestContext> {
  return request.newContext({
    // Trailing slash is load-bearing: Playwright joins with new URL(), so
    // without it "auth/login" would replace /api/v1 instead of extending it.
    baseURL: `${env.apiURL}/`,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      // The server derives the streak day boundary from this; without it every
      // test implicitly asserts against the API's UTC clock instead.
      'X-Timezone': 'Europe/Istanbul',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

/** Body of a response that may have failed. Never throws on a non-2xx. */
export async function body<T>(response: APIResponse): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Expected JSON from ${response.url()} (${response.status()}), got: ${text.slice(0, 200)}`,
    );
  }
}

export async function errorOf(response: APIResponse): Promise<ApiError> {
  return body<ApiError>(response);
}

/**
 * `Retry-After` in seconds, the way the web client reads it. Both the limiter
 * and the account lockout send it, and the two mean different things, so the
 * tests that assert on a wait take it from the header rather than the sentence.
 */
export function retryAfterSeconds(response: APIResponse): number | null {
  const header = response.headers()['retry-after'];
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : null;
}
