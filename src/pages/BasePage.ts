import { expect, type Locator, type Page } from '@playwright/test';
import { t } from '../utils/i18n';

/**
 * Shared behaviour for every page object.
 *
 * ## Selector policy
 *
 * Every locator in this directory is built in this order, and the order is the
 * point of the exercise:
 *
 *   1. `getByRole` with an accessible name
 *   2. `getByLabel`
 *   3. a semantic attribute the markup already needs — `type`, `autocomplete`
 *   4. `data-testid`, only where semantics genuinely cannot identify the thing
 *   5. a CSS class — never
 *
 * The reason is not style. A locator built on the accessible name fails when a
 * control stops being announceable, which is a real defect; a locator built on
 * `.btn-primary` passes while the button is unreachable by keyboard and
 * invisible to a screen reader, and breaks when someone changes a colour. The
 * first pass of this suite found six places where the app had no accessible
 * name to select by at all, and those were fixed in the app rather than
 * papered over with test ids.
 *
 * (4) is reserved for two situations that come up in this app: one row among
 * twenty identically-labelled ones, and a control the layout renders twice —
 * the CSV wizard draws its mapping fields as both a table and a stack, so a
 * plain `select` query matches each field twice.
 */
export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  /** The route this page lives at, for `open()`. */
  abstract readonly path: string;

  async open(): Promise<void> {
    await this.page.goto(this.path);
    await this.waitUntilReady();
  }

  /**
   * Resolves once the route's own content is on screen.
   *
   * Overridden per page. The default waits out the lazy chunk: every feature
   * page is `React.lazy` behind one `<Suspense>`, so the first paint after a
   * navigation is a loader and any assertion made then is a race.
   */
  async waitUntilReady(): Promise<void> {
    await this.pageLoader.waitFor({ state: 'hidden' }).catch(() => {
      // Already gone, or never shown because the chunk was cached.
    });
  }

  /** `components/ui/PageLoader`, the Suspense fallback and the guard's spinner. */
  get pageLoader(): Locator {
    return this.page.getByRole('status');
  }

  /**
   * An error the page announced. Both auth forms mark theirs `role="alert"`,
   * which is also how a screen reader learns the submit failed.
   */
  get alert(): Locator {
    return this.page.getByRole('alert');
  }

  /** The app's one modal component, which is named by its own heading. */
  dialog(name?: string | RegExp): Locator {
    return name
      ? this.page.getByRole('dialog', { name })
      : this.page.getByRole('dialog');
  }

  get currentPath(): string {
    return new URL(this.page.url()).pathname;
  }

  /**
   * `AppErrorBoundary`'s fallback.
   *
   * Worth a named locator because it is the one thing that can make almost any
   * assertion pass while the page is in fact broken: the crash screen renders
   * INSIDE `<main>`, so "the route rendered something" is true of it. A route
   * test that only checked for content passed against a completely dead
   * /analytics until this was added.
   *
   * There is no third-party error tracking in this app by choice, so this
   * screen plus the feedback form is the only way a render crash gets reported
   * at all — which makes asserting its absence the suite's job.
   */
  get crashScreen(): Locator {
    return this.page.getByText(t('eb.title'));
  }

  /** Fails with the crash screen named, rather than with a missing element. */
  async expectNoCrash(): Promise<void> {
    await expect(
      this.crashScreen,
      'the page rendered AppErrorBoundary — something threw during render',
    ).toHaveCount(0);
  }

  /** Reads a localStorage key, for the tests that assert a preference stuck. */
  async storage(key: string): Promise<string | null> {
    return this.page.evaluate((name) => {
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    }, key);
  }
}
