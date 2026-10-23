import type { Locator, Page } from '@playwright/test';
import { t, tIn, pattern } from '../utils/i18n';
import { escapeRegExp } from '../utils/regex';

/**
 * The chrome around every signed-in page: top bar, navigation, theme and
 * language toggles.
 *
 * Not a `BasePage` — it has no route of its own. A page object composes it
 * rather than inheriting from it, because "the journal" and "the shell the
 * journal sits in" fail for different reasons and a test should be able to say
 * which.
 *
 * Below `lg` the navigation is a drawer behind a menu button, and the same
 * links exist in both. `navLink` therefore scopes to whichever is on screen
 * instead of assuming one.
 */
export class AppShell {
  constructor(private readonly page: Page) {}

  /** `a[href]` because `NavLink` renders the route, and the route is stable. */
  navLink(path: string): Locator {
    return this.page.locator(`a[href="${path}"]`).first();
  }

  get mobileMenuButton(): Locator {
    return this.page.getByRole('button', { name: t('topbar.openMenu') });
  }

  get mobileMenuCloseButton(): Locator {
    return this.page.getByRole('button', { name: t('topbar.closeMenu') });
  }

  get mobileDrawer(): Locator {
    return this.page.getByRole('dialog');
  }

  get signOutButton(): Locator {
    return this.page.getByRole('button', { name: t('topbar.signOut') });
  }

  /**
   * The toggle is labelled by what it will DO, not by the current theme, so the
   * two states are two different accessible names.
   */
  get themeToggle(): Locator {
    return this.page.getByRole('button', {
      name: new RegExp(`${escapeRegExp(t('topbar.switchToLight'))}|${escapeRegExp(t('topbar.switchToDark'))}`),
    });
  }

  /**
   * The one control in the app whose text is not routed through `t()` — it is
   * always the name of the OTHER language, which is the right call for a
   * language switch and the reason it is hard-coded.
   */
  get languageToggle(): Locator {
    return this.page.getByRole('button', { name: /Switch to English|Türkçeye geç/ });
  }

  /**
   * The flame badge carrying `user.streakDays`.
   *
   * Matched by its interpolating label rather than a test id: the streak has no
   * endpoint of its own — the server counts the day on the three calls that
   * already return a user — so this badge is the only place the client's idea
   * of it is visible, and the number in it is the assertion.
   */
  get streakBadge(): Locator {
    // The stat strip is rendered twice — `hidden lg:flex` in the top bar and
    // `flex lg:hidden` lower down — so the one that is painted depends on the
    // viewport. Filtering on visibility picks whichever that is, where scoping
    // to the banner worked on desktop and found nothing on a phone.
    return this.page.getByText(pattern('topbar.streak')).filter({ visible: true });
  }

  async streakDays(): Promise<number> {
    const text = (await this.streakBadge.textContent()) ?? '';
    const digits = text.match(/\d+/);
    if (!digits) throw new Error(`No number in the streak badge: "${text}"`);
    return Number(digits[0]);
  }

  /**
   * Whether the narrow layout is the one on screen.
   *
   * Read from the viewport rather than by asking whether the menu button is
   * visible: `isVisible()` does not wait, so on a page that has not finished
   * rendering it answers `false` and the caller confidently takes the desktop
   * branch on a phone. The breakpoint is the `lg` one the layout itself uses.
   */
  get isNarrow(): boolean {
    return (this.page.viewportSize()?.width ?? 1440) < 1024;
  }

  /**
   * Opens the drawer, if this layout has one. Idempotent.
   *
   * The sidebar's contents — nav AND the XP/streak strip — exist only inside
   * the drawer below `lg`, so anything that reads them has to open it first.
   */
  async openNav(): Promise<void> {
    if (!this.isNarrow) return;
    if (await this.mobileDrawer.isVisible()) return;
    await this.mobileMenuButton.click();
    await this.mobileDrawer.waitFor({ state: 'visible' });
  }

  async navigateTo(path: string): Promise<void> {
    const matches = new RegExp(`${path.replace(/\//g, '\\/')}$`);

    if (this.isNarrow) {
      await this.openNav();
      await this.mobileDrawer.locator(`a[href="${path}"]`).first().click();
      // Waiting for the URL is not optional: each feature page is a lazy chunk,
      // so the click returns long before the route renders, and the next one in
      // a loop lands on a nav that is mid-re-render — reported as "element was
      // detached from the DOM", which points at the link rather than at the
      // navigation that had not finished. The drawer closes on navigation, so
      // it is waited out too or the next open finds it mid-close.
      await this.page.waitForURL(matches);
      await this.mobileDrawer.waitFor({ state: 'hidden' });
      return;
    }

    await this.navLink(path).click();
    await this.page.waitForURL(matches);
  }

  /**
   * Signs out.
   *
   * There is exactly one sign-out control and it lives in the top bar on every
   * viewport, so no branching is needed — which two earlier versions of this
   * method got wrong in the same way. Both asked `isVisible()`/`count()` first,
   * neither of which waits, so on a page that had not finished rendering they
   * answered "no" and fell through to hunting for a button in the drawer that
   * was never there. A plain click auto-waits and is the whole job.
   */
  async signOut(): Promise<void> {
    await this.signOutButton.click();
  }

  /** The language the document claims, which the switch is supposed to change. */
  htmlLang(): Promise<string | null> {
    return this.page.locator('html').getAttribute('lang');
  }

  /**
   * The theme is applied as a CLASS on `<html>` (`light`/`dark`), not as a data
   * attribute — ThemeContext toggles both classes and the pre-paint snippet in
   * index.html does the same, so the class is what is authoritative.
   */
  async theme(): Promise<'light' | 'dark' | null> {
    const classes = (await this.page.locator('html').getAttribute('class')) ?? '';
    if (/\blight\b/.test(classes)) return 'light';
    if (/\bdark\b/.test(classes)) return 'dark';
    return null;
  }

  /** A string in the language the page is NOT currently in. */
  stringIn(lang: 'tr' | 'en'): (key: Parameters<typeof tIn>[0]) => string {
    return (key) => tIn(key, lang);
  }
}

