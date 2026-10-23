import type { APIRequestContext, APIResponse } from '@playwright/test';

export function me(api: APIRequestContext): Promise<APIResponse> {
  return api.get('users/me');
}

/** No soft delete and no grace period — the row and everything under it goes. */
export function deleteMe(
  api: APIRequestContext,
  data: { password: string; confirmEmail: string },
): Promise<APIResponse> {
  return api.delete('users/me', { data });
}
