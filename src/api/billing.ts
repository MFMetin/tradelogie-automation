import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * The paywall's test door. `requireAuth` only — no premium check, no admin —
 * so any verified user can grant themselves up to 365 days. It is enabled by
 * ENABLE_MOCK_BILLING, which defaults to on when the variable is absent.
 */
export function activateMock(api: APIRequestContext, days = 30): Promise<APIResponse> {
  return api.post('billing/activate-mock', { data: { days } });
}
