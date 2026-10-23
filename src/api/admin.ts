import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * The admin surface the fixtures lean on.
 *
 * Every test account after the first is manufactured through these — register
 * over HTTP, then verify and grant premium as the admin — so the fixtures
 * exercise the product's own endpoints instead of writing rows behind its back.
 * It also means these three stay covered by every run that uses a user.
 */

/** The break-glass the admin panel offers for an account stuck unverified. */
export function verifyUserEmail(api: APIRequestContext, userId: string): Promise<APIResponse> {
  return api.post(`admin/users/${userId}/verify-email`);
}

export function setPremium(
  api: APIRequestContext,
  userId: string,
  data: { isPremium: boolean; days?: number; mode?: 'extend' | 'set'; lifetime?: boolean },
): Promise<APIResponse> {
  // The schema is `.strict()`, so an extra key is a 400 rather than ignored.
  return api.patch(`admin/users/${userId}/premium`, { data });
}

export function setRole(
  api: APIRequestContext,
  userId: string,
  role: string,
): Promise<APIResponse> {
  return api.patch(`admin/users/${userId}/role`, { data: { role } });
}

export function deleteUser(api: APIRequestContext, userId: string): Promise<APIResponse> {
  return api.delete(`admin/users/${userId}`);
}

export function listUsers(api: APIRequestContext, search?: string): Promise<APIResponse> {
  return api.get('admin/users', { params: search ? { search } : {} });
}

export function getAudit(api: APIRequestContext): Promise<APIResponse> {
  return api.get('admin/audit');
}
