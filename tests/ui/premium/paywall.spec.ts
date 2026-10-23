import { test, expect } from '../../../src/fixtures/base';
import { t } from '../../../src/utils/i18n';
import { newApiContext, body } from '../../../src/api/client';
import type { ApiUser } from '../../../src/api/client';

/** Every route behind `PremiumGate`, from App.tsx. */
const GATED = ['/dashboard', '/journal', '/markets', '/analytics', '/education'] as const;

test.describe('the paywall', () => {
  test('a free user is sent to billing from every gated route', async ({ pageAs, freeUser }) => {
    const page = await pageAs(freeUser);

    for (const path of GATED) {
      await page.goto(path);
      // `PremiumGate` reads `hasActivePremium(user)`, not the raw flag, so a
      // lapsed subscription lands here too.
      await expect(page, `${path} should redirect a free user`).toHaveURL(/\/billing$/);
    }
  });

  test('the ungated routes stay open to a free user', async ({ pageAs, freeUser }) => {
    const page = await pageAs(freeUser);

    // The paywall has to be reachable, and so does the profile — a user who
    // cannot read their own account cannot be told why they are stuck.
    for (const path of ['/billing', '/profile', '/feedback']) {
      await page.goto(path);
      await expect(page, `${path} should stay open`).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByText(t('eb.title'))).toHaveCount(0);
    }
  });

  test('activating the test grant opens the app', async ({ pageAs, freeUser }) => {
    const page = await pageAs(freeUser);
    await page.goto('/journal');
    await expect(page).toHaveURL(/\/billing$/);

    // `bl.activateTest` is behind ENABLE_MOCK_BILLING. It posts
    // `/billing/activate-mock { days: 30 }`, which needs only a session.
    await page.getByRole('button', { name: t('bl.activateTest') }).click();

    await expect
      .poll(
        async () => {
          await page.goto('/journal');
          return new URL(page.url()).pathname;
        },
        { timeout: 20_000, message: 'the journal never opened after the grant' },
      )
      .toBe('/journal');

    const api = await newApiContext(freeUser.accessToken);
    try {
      const profile = await body<ApiUser>(await api.get('users/me'));
      expect(profile.isPremium).toBe(true);
      expect(new Date(profile.premiumUntil!).getTime()).toBeGreaterThan(Date.now());
    } finally {
      await api.dispose();
    }
  });

  test('a forged cached profile is corrected before it buys anything', async ({
    pageAs,
    freeUser,
  }) => {
    // `PremiumGate` reads the cached `tj_user`, so writing `isPremium: true`
    // into localStorage does get past the client-side guard — the comment in
    // AuthContext says as much, and calls the result "an empty page, not
    // access". What actually happens is better than that: `AuthContext`
    // revalidates with `GET /users/me` on boot, the real profile replaces the
    // forgery, and the gate sends them to the paywall before the journal has
    // asked for a single trade.
    const page = await pageAs({
      ...freeUser,
      user: { ...freeUser.user, isPremium: true, premiumUntil: null },
    });

    const tradeRequests: number[] = [];
    page.on('response', (response) => {
      if (/\/api\/v1\/trades/.test(response.url())) tradeRequests.push(response.status());
    });

    await page.goto('/journal');

    await expect(page, 'the revalidated profile should win').toHaveURL(/\/billing$/, {
      timeout: 20_000,
    });

    // Usually the journal never asks for anything at all — the gate closes
    // before its query fires. Under load the order can swap, and then the only
    // thing that matters is that the request was refused. Asserting "no
    // request" alone made this flaky on a busy machine for no gain: the
    // guarantee being tested is that a forged cache gets no DATA.
    expect(
      tradeRequests.every((status) => status === 403),
      `the journal got a non-403 from /trades: ${tradeRequests.join(', ')}`,
    ).toBe(true);
  });

  test('and the server would refuse it anyway', async ({ freeUser }) => {
    // The half that does not depend on any client behaviour. Whatever the page
    // believes, every request is re-gated.
    const api = await newApiContext(freeUser.accessToken);
    try {
      expect((await api.get('trades')).status()).toBe(403);
      expect((await api.post('trades', { data: { symbol: 'BTCUSDT' } })).status()).toBe(403);
    } finally {
      await api.dispose();
    }
  });
});
