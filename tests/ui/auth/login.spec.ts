import { test, expect } from '../../../src/fixtures/base';
import { LoginPage } from '../../../src/pages/LoginPage';
import { AppShell } from '../../../src/pages/AppShell';
import { t, format } from '../../../src/utils/i18n';
import {
  createPremiumUser,
  createUnverifiedUser,
  uniqueEmail,
  DEFAULT_PASSWORD,
} from '../../../src/fixtures/users';
import { newApiContext } from '../../../src/api/client';
import * as auth from '../../../src/api/auth';

test.describe('signing in', () => {
  test('a premium account lands on the dashboard', async ({ anonPage, premiumUser }) => {
    const login = new LoginPage(anonPage);
    await login.open();

    await login.signIn(premiumUser.email, premiumUser.password);

    // `from` defaults to '/', and HomeRoute sends a signed-in user on to the
    // dashboard — so this is two redirects, not one.
    await expect(anonPage).toHaveURL(/\/dashboard$/);
  });

  test('a wrong password says the password was wrong', async ({ anonPage, premiumUser }) => {
    const login = new LoginPage(anonPage);
    await login.open();

    await login.signIn(premiumUser.email, 'Wr0ngPassw0rd!');

    await expect(login.alert).toHaveText(t('auth.invalidCredentials'));
    // And specifically NOT the verification prompt: offering "resend" to
    // someone who simply mistyped sends them to their inbox for nothing.
    await expect(login.resendVerification).toBeHidden();
    await expect(anonPage).toHaveURL(/\/login$/);
  });

  test('an unverified account is offered a resend, not a password error', async ({
    anonPage,
    anonApi,
  }) => {
    const account = await createUnverifiedUser(anonApi, 'ui-unverified');
    const login = new LoginPage(anonPage);
    await login.open();

    await login.signIn(account.email, account.password);

    // The page reads 403 EMAIL_NOT_VERIFIED off the response. A generic error
    // here would imply the password was wrong, which is a dead end: no number
    // of retries fixes an unverified account.
    await expect(login.alert).toHaveText(t('auth.loginNeedsVerify'));
    await expect(login.resendVerification).toBeVisible();
  });

  test('the resend button reports success without confirming the account exists', async ({
    anonPage,
    anonApi,
  }) => {
    const account = await createUnverifiedUser(anonApi, 'ui-resend');
    const login = new LoginPage(anonPage);
    await login.open();
    await login.signIn(account.email, account.password);

    await login.resendVerification.click();

    await expect(anonPage.getByText(t('auth.resendSent'))).toBeVisible();
  });

  test('an unknown address gets the same error as a wrong password', async ({ anonPage }) => {
    const login = new LoginPage(anonPage);
    await login.open();

    await login.signIn(uniqueEmail('nobody'), DEFAULT_PASSWORD);

    // Same sentence either way. A distinct "no such account" turns the login
    // form into a way to ask whether an address is registered.
    await expect(login.alert).toHaveText(t('auth.invalidCredentials'));
  });

  test('a locked account is told how long to wait @lockout', async ({ anonPage, anonApi }) => {
    const user = await createPremiumUser('ui-lock');

    // Spent over the API rather than through the form: five UI round trips to
    // reach the interesting state is four tests' worth of time spent proving
    // something login.spec already covers at the API layer.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login(anonApi, { email: user.email, password: 'Wr0ngPassw0rd!' });
    }

    const login = new LoginPage(anonPage);
    await login.open();
    await login.signIn(user.email, user.password);

    // The server's own message is English and `apiErrorMessage` leaves it
    // alone — it only rewrites RATE_LIMITED — so the page localizes this
    // itself from Retry-After. Over 90 seconds it rounds to minutes, which the
    // 5-minute first tier always is.
    await expect(login.alert).toHaveText(
      format('auth.accountLockedInMinutes', { minutes: 5 }),
    );
  });
});

test.describe('route guards', () => {
  test('a protected route sends you to login and then back to it', async ({
    anonPage,
    premiumUser,
  }) => {
    await anonPage.goto('/journal');

    // `ProtectedRoute` navigates with `state={{ from }}`, and LoginPage reads
    // it. Losing that is the difference between a bookmark working and
    // dumping everyone on the dashboard.
    await expect(anonPage).toHaveURL(/\/login$/);

    const login = new LoginPage(anonPage);
    await login.signIn(premiumUser.email, premiumUser.password);

    await expect(anonPage).toHaveURL(/\/journal$/);
  });

  test('a signed-in user cannot open the login page', async ({ authedPage }) => {
    await authedPage.goto('/login');
    // PublicOnlyRoute sends them to '/', and HomeRoute on to the dashboard.
    await expect(authedPage).toHaveURL(/\/dashboard$/);
  });

  test('signing out returns you to a signed-out app', async ({ authedPage }) => {
    await authedPage.goto('/dashboard');
    const shell = new AppShell(authedPage);

    await shell.signOut();

    await expect(authedPage).toHaveURL(/\/(login)?$/);
    // The tokens are gone, so a protected route is no longer reachable.
    await authedPage.goto('/journal');
    await expect(authedPage).toHaveURL(/\/login$/);
  });
});

test.describe('email verification', () => {
  test('a minted link signs the user straight in', async ({ anonPage, anonApi, adminApi }) => {
    const account = await createUnverifiedUser(anonApi, 'ui-verify');
    const { mintToken } = await import('../../../src/db/tokens');
    const token = await mintToken(account.id, 'email_verify');

    await anonPage.goto(`/verify-email?token=${token}`);

    // `/verify-email` sits OUTSIDE PublicOnlyRoute on purpose, and the endpoint
    // answers with a token pair — so clicking the link is the sign-in.
    await expect(anonPage).toHaveURL(/\/(dashboard|billing)$/, { timeout: 20_000 });
    expect(adminApi).toBeTruthy();
  });

  test('an unverified user who verifies elsewhere can then sign in', async ({
    anonPage,
    anonApi,
    adminApi,
  }) => {
    const account = await createUnverifiedUser(anonApi, 'ui-verified-later');
    const { verifyUserEmail, setPremium } = await import('../../../src/api/admin');
    await verifyUserEmail(adminApi, account.id);
    await setPremium(adminApi, account.id, { isPremium: true, lifetime: true });

    const login = new LoginPage(anonPage);
    await login.open();
    await login.signIn(account.email, account.password);

    await expect(anonPage).toHaveURL(/\/dashboard$/);
  });
});

test.describe('password reset', () => {
  test('a minted reset link sets a new password', async ({ anonPage }) => {
    const user = await createPremiumUser('ui-reset');
    const { mintToken } = await import('../../../src/db/tokens');
    const token = await mintToken(user.id, 'password_reset');

    await anonPage.goto(`/reset-password?token=${token}`);

    const newPassword = 'Brand0NewPassw0rd!';
    // This page has its own labels — `auth.newPassword` / `auth.confirmPassword`,
    // not the register form's pair — and both fields carry
    // `autocomplete="new-password"`, so the labels are the only thing that tells
    // them apart.
    await anonPage.getByLabel(t('auth.newPassword'), { exact: true }).fill(newPassword);
    await anonPage.getByLabel(t('auth.confirmPassword'), { exact: true }).fill(newPassword);
    await anonPage.getByRole('button', { name: t('common.submit') }).click();

    const api = await newApiContext();
    try {
      await expect
        .poll(async () => (await auth.login(api, { email: user.email, password: newPassword })).ok(), {
          timeout: 15_000,
        })
        .toBe(true);
      // And the old one no longer works.
      expect((await auth.login(api, { email: user.email, password: user.password })).ok()).toBe(
        false,
      );
    } finally {
      await api.dispose();
    }
  });
});
