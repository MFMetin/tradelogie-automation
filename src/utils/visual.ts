import type { Locator, Page } from '@playwright/test';

/**
 * Makes a page hold still long enough to be photographed.
 *
 * Visual regression fails for two completely different reasons, and only one of
 * them is a bug. These are the four sources of the other kind in this app:
 *
 *   1. **Animation.** Playwright's `animations: 'disabled'` freezes CSS
 *      animations and transitions, but the app also has `animate-[fadeIn]` on
 *      modals and `transition` on dozens of hover states. Killing them in CSS
 *      too is belt and braces, and cheap.
 *   2. **Charts.** recharts and klinecharts lay out from a measured container
 *      and animate on mount, so they are a pixel or two different every render.
 *      They are masked rather than disabled: a mask proves the chart is THERE
 *      and the right size without asserting its anti-aliasing.
 *   3. **Time.** Every relative date ("2 days ago") and the streak badge move
 *      with the clock. The clock is pinned.
 *   4. **Fonts.** A screenshot taken before Sora loads shows the fallback, so
 *      `document.fonts.ready` has to be awaited — and that is also why
 *      baselines are per platform.
 */
export async function settleForScreenshot(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
      /* The caret blinks, which is a one-pixel diff on any focused input. */
      * { caret-color: transparent !important; }
    `,
  });

  // The fallback face has different metrics, so a screenshot taken before Sora
  // arrives is a different layout rather than a different colour.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle').catch(() => {
    // A page that keeps a connection open never reaches networkidle; the font
    // wait above is the one that actually matters.
  });
}

/**
 * Freezes the clock before the bundle evaluates.
 *
 * A fixed instant rather than a fixed offset: anything formatted as a date, and
 * the streak badge in particular, changes with the real clock, so a baseline
 * taken today fails tomorrow for no reason at all.
 */
export async function freezeClock(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-06-15T12:00:00.000Z') });
}

/** Everything whose exact pixels are not worth asserting. */
export function volatileRegions(page: Page): Locator[] {
  return [
    // Charts: masked, not hidden, so the screenshot still proves one is there
    // and the right size.
    page.locator('.recharts-wrapper'),
    page.locator('canvas'),
    // The XP bar and the streak badge move with real account state.
    page.locator('[role="progressbar"]'),
  ];
}
