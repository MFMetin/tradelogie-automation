import type { APIRequestContext, APIResponse } from '@playwright/test';
import { body, type LoginResponse, type TokenPair } from './client';

export interface RegisterResponse {
  requires_verification: boolean;
  email: string;
  message?: string;
}

export function register(
  api: APIRequestContext,
  data: { email: string; password: string; username: string },
): Promise<APIResponse> {
  return api.post('auth/register', { data });
}

export function login(
  api: APIRequestContext,
  data: { email: string; password: string },
): Promise<APIResponse> {
  return api.post('auth/login', { data });
}

/** Throws rather than returning a failed response — for fixture use. */
export async function loginOrThrow(
  api: APIRequestContext,
  email: string,
  password: string,
): Promise<LoginResponse> {
  const response = await login(api, { email, password });
  if (!response.ok()) {
    throw new Error(`Login failed for ${email}: ${response.status()} ${await response.text()}`);
  }
  return body<LoginResponse>(response);
}

export function verifyEmail(api: APIRequestContext, token: string): Promise<APIResponse> {
  return api.post('auth/verify-email', { data: { token } });
}

export function refresh(api: APIRequestContext, refreshToken: string): Promise<APIResponse> {
  return api.post('auth/refresh', { data: { refresh_token: refreshToken } });
}

export function logout(api: APIRequestContext, refreshToken: string): Promise<APIResponse> {
  return api.post('auth/logout', { data: { refresh_token: refreshToken } });
}

export function resendVerification(api: APIRequestContext, email: string): Promise<APIResponse> {
  return api.post('auth/resend-verification', { data: { email } });
}

export function requestPasswordReset(api: APIRequestContext, email: string): Promise<APIResponse> {
  return api.post('auth/reset-password', { data: { email } });
}

export function confirmPasswordReset(
  api: APIRequestContext,
  token: string,
  password: string,
): Promise<APIResponse> {
  return api.post('auth/reset-password/confirm', { data: { token, password } });
}

/** Answers a fresh pair, because the server revoked every refresh token. */
export function changePassword(
  api: APIRequestContext,
  data: { current_password: string; new_password: string },
): Promise<APIResponse> {
  return api.post('auth/change-password', { data });
}

export async function tokensFrom(response: APIResponse): Promise<TokenPair> {
  return body<TokenPair>(response);
}
