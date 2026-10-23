import type { Locator } from '@playwright/test';
import { BasePage } from './BasePage';
import { t } from '../utils/i18n';

export class RegisterPage extends BasePage {
  readonly path = '/register';

  get email(): Locator {
    return this.page.getByLabel(t('auth.email'), { exact: true });
  }

  get username(): Locator {
    return this.page.getByLabel(t('auth.username'), { exact: true });
  }

  get password(): Locator {
    return this.page.getByLabel(t('auth.password'), { exact: true });
  }

  /**
   * Both password fields carry `autocomplete="new-password"`, so that attribute
   * cannot tell them apart — the labels are the only thing that can, which is
   * the ordinary reason to prefer them.
   */
  get confirmPassword(): Locator {
    return this.page.getByLabel(t('auth.repeatPassword'), { exact: true });
  }

  get submit(): Locator {
    return this.page.getByRole('button', { name: t('auth.register'), exact: true });
  }

  /** The panel that replaces the form once registration succeeds. */
  get verifyPrompt(): Locator {
    return this.page.getByText(t('auth.verifyTitle'));
  }

  get loginLink(): Locator {
    return this.page.locator('a[href="/login"]');
  }

  async signUp(email: string, username: string, password: string): Promise<void> {
    await this.email.fill(email);
    await this.username.fill(username);
    await this.password.fill(password);
    await this.confirmPassword.fill(password);
    await this.submit.click();
  }

  override async waitUntilReady(): Promise<void> {
    await this.submit.waitFor({ state: 'visible' });
  }
}
