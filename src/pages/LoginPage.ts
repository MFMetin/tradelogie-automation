import type { Locator, Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { t } from '../utils/i18n';

export class LoginPage extends BasePage {
  readonly path = '/login';

  constructor(page: Page) {
    super(page);
  }

  /**
   * `getByLabel` works here because the app now associates the label with the
   * input. It did not when this suite started — both auth forms rendered a
   * `<label>` with no `htmlFor` over an input with no id, so the field had no
   * accessible name at all. That was fixed in the app rather than worked
   * around with `[placeholder="you@example.com"]`, which would have passed
   * forever while the field stayed unreachable.
   */
  get email(): Locator {
    return this.page.getByLabel(t('auth.email'), { exact: true });
  }

  /** `PasswordField` has always associated its own label. */
  get password(): Locator {
    return this.page.getByLabel(t('auth.password'), { exact: true });
  }

  get submit(): Locator {
    return this.page.getByRole('button', { name: t('auth.login'), exact: true });
  }

  /** Offered only when the server answered 403 EMAIL_NOT_VERIFIED. */
  get resendVerification(): Locator {
    return this.page.getByRole('button', { name: t('auth.resendVerification') });
  }

  get forgotPasswordLink(): Locator {
    return this.page.locator('a[href="/forgot-password"]');
  }

  get registerLink(): Locator {
    return this.page.locator('a[href="/register"]');
  }

  get passwordVisibilityToggle(): Locator {
    return this.page.getByRole('button', { name: t('auth.showPassword') });
  }

  async fill(email: string, password: string): Promise<void> {
    await this.email.fill(email);
    await this.password.fill(password);
  }

  async signIn(email: string, password: string): Promise<void> {
    await this.fill(email, password);
    await this.submit.click();
  }

  override async waitUntilReady(): Promise<void> {
    await this.submit.waitFor({ state: 'visible' });
  }
}
