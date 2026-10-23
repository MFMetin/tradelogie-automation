import { test, expect } from '@playwright/test';

/**
 * The live site, read only.
 *
 * Imports nothing from `src/` on purpose — no fixtures, no database, no
 * session. Every assertion here is something a crawler could check, which is
 * what makes this safe to point at production on a schedule.
 *
 * The suite's language helper is not used either: the live site serves its own
 * default (Turkish), and pinning it would mean writing to localStorage, which
 * is more than a read-only check should do. Assertions are therefore on
 * structure and headers rather than on copy.
 */
const PUBLIC_PAGES = ['/', '/login', '/register'] as const;
const LEGAL_PAGES = ['/privacy', '/terms', '/kvkk', '/distance-sales'] as const;

test.describe('the public pages render', () => {
  for (const path of [...PUBLIC_PAGES, ...LEGAL_PAGES]) {
    test(`${path} loads and mounts the app`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status(), `GET ${path}`).toBe(200);

      // The app mounted and painted something: `#root` has children.
      await expect(page.locator('#root')).not.toBeEmpty();

      // And it did not crash on the way. `AppErrorBoundary` renders inside the
      // page, so "something is there" is true of a crash screen too.
      await expect(page.getByText(/Bir şeyler ters gitti|Something went wrong/)).toHaveCount(0);
    });
  }

  test('the landing page has a heading and a route into the app', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.locator('a[href="/register"], a[href="/login"]').first()).toBeVisible();
  });
});

test.describe('404s are real', () => {
  test('an unknown address answers 404, not 200', async ({ request }) => {
    const response = await request.get('/this-page-does-not-exist-e2e-smoke');
    // A SPA that answers 200 for everything tells a crawler every typo is a
    // page. The server reads `dist/routes.json` to avoid exactly that.
    expect(response.status()).toBe(404);
  });

  test('a real route still answers 200', async ({ request }) => {
    expect((await request.get('/login')).status()).toBe(200);
  });
});

test.describe('security headers are live', () => {
  test('the CSP, nosniff and HSTS are all served', async ({ request }) => {
    const headers = (await request.get('/')).headers();

    const csp = headers['content-security-policy'];
    expect(csp, 'no CSP in production').toBeTruthy();

    // Scoped to script-src, not the whole policy. `style-src 'unsafe-inline'`
    // is there and has to be: Tailwind emits inline styles, and the connected-
    // account tiles set their brand colour as an inline `style` because a
    // per-platform hex cannot be a static class the scanner would see.
    // Inline SCRIPT is the one that matters, and it is allowed only by hash —
    // computed from the pre-paint theme snippet at boot, so editing that
    // snippet is safe while adding a second inline script is not.
    const scriptSrc = csp!.split(';').find((part) => part.trim().startsWith('script-src'));
    expect(scriptSrc, 'no script-src directive').toBeTruthy();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).toMatch(/'sha256-[A-Za-z0-9+/=]+'/);

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['strict-transport-security']).toBeTruthy();
  });

  test('the CSP lets the app reach its own API', async ({ request }) => {
    const csp = (await request.get('/')).headers()['content-security-policy']!;
    // Baked at build time from a build arg the runtime stage re-declares. Wrong
    // here and the deployed app loads and then does nothing at all — which is
    // the single most expensive way for this to break.
    expect(csp).toMatch(/connect-src[^;]*https:\/\/\S+/);
  });
});

test.describe('compression is on', () => {
  test('the shell is served brotli-compressed', async ({ request }) => {
    const response = await request.get('/', {
      headers: { 'Accept-Encoding': 'br, gzip' },
    });
    expect(['br', 'gzip']).toContain(response.headers()['content-encoding']);
  });
});

test.describe('the SEO assets are intact', () => {
  test('robots.txt is served and names the sitemap', async ({ request }) => {
    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);
    expect(await response.text()).toMatch(/Sitemap:/i);
  });

  test('the sitemap parses and lists only public addresses', async ({ request }) => {
    const response = await request.get('/sitemap.xml');
    expect(response.status()).toBe(200);

    const xml = await response.text();
    expect(xml).toContain('<urlset');
    expect(xml).toContain('/login');

    // A private route in the sitemap invites crawlers to pages that redirect
    // them straight back out, and publishes the shape of the app for nothing.
    for (const path of ['/dashboard', '/journal', '/admin', '/profile']) {
      expect(xml, `sitemap must not list ${path}`).not.toMatch(
        new RegExp(`<loc>[^<]*${path}</loc>`),
      );
    }
  });

  test('the share image is actually reachable', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const ogImage = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1];
    expect(ogImage, 'no og:image in the head').toBeTruthy();

    // A broken og:image is invisible on the site and visible in every link
    // anyone shares — the worst ratio of "easy to miss" to "seen in public".
    const image = await request.get(ogImage!);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toContain('image');
  });

  test('the canonical URL points at the live domain', async ({ request, baseURL }) => {
    const html = await (await request.get('/')).text();
    const canonical = html.match(/rel="canonical"\s+href="([^"]+)"/)?.[1];
    expect(canonical).toBeTruthy();
    expect(canonical).toContain(new URL(baseURL!).host);
  });

  test('the structured data parses', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const blocks = [
      ...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    ];
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of blocks) {
      expect(() => JSON.parse(block[1]!)).not.toThrow();
    }
  });

  test('the home-screen manifest and icons are served', async ({ request }) => {
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);

    const parsed = (await manifest.json()) as { icons?: { src: string }[] };
    expect(parsed.icons?.length ?? 0).toBeGreaterThan(0);

    for (const icon of parsed.icons ?? []) {
      expect((await request.get(icon.src)).status(), icon.src).toBe(200);
    }
    expect((await request.get('/apple-touch-icon.png')).status()).toBe(200);
  });
});

test.describe('the apex is canonical', () => {
  test('www redirects to the apex', async ({ request, baseURL }) => {
    const host = new URL(baseURL!).host;
    test.skip(host.startsWith('www.'), 'baseURL is already the www host');

    const response = await request.get(`https://www.${host}/`, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });

    // 301 before anything else is served. Two hosts serving the same app is
    // duplicate content, and splits every cache and every link.
    expect(response.status()).toBe(301);
    expect(response.headers()['location']).toContain(host);
  });
});
