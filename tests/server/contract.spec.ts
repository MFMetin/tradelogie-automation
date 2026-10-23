import { test, expect } from '../../src/fixtures/base';
import { env } from '../../src/config/env';

/**
 * `server.js` — the zero-dependency static server the production bundle is
 * actually served by.
 *
 * Everything here is something the project's own notes call easy to undo by
 * accident, and every one of them is invisible in a browser until it matters:
 * a 200 where a 404 belonged is only visible to a crawler, a broken
 * `connect-src` only on a deploy, and a caching regression only in a waterfall.
 * None of it exists under the Vite dev server, which is why this project runs
 * against the built bundle by default and skips this file when it does not.
 *
 * `request` rather than a page: these are assertions about responses, and a
 * browser would hide the status behind a rendered page.
 */
test.describe('real 404s', () => {
  test('an address that is not a route gets a 404 status', async ({ request }) => {
    const response = await request.get(`${env.baseURL}/definitely-not-a-page`);

    // The SPA shell is still served — the client renders NotFoundPage — but the
    // STATUS is 404. A redirect to `/` threw the typo away silently and handed
    // crawlers a 200 for every address that has ever been mistyped.
    expect(response.status()).toBe(404);
    expect(await response.text()).toContain('<div id="root">');
  });

  test('a real route gets a 200', async ({ request }) => {
    for (const path of ['/', '/login', '/privacy', '/journal', '/dashboard']) {
      const response = await request.get(`${env.baseURL}${path}`);
      expect(response.status(), `GET ${path}`).toBe(200);
    }
  });

  test('the route manifest the server reads is actually emitted', async ({ request }) => {
    // `dist/routes.json` comes from the seoAssets plugin, which is gated on
    // VITE_SITE_URL. Without it the manifest is missing, server.js falls back
    // to answering 200 for everything, and the test above passes for the wrong
    // reason. Checking the manifest exists is what keeps that honest.
    const response = await request.get(`${env.baseURL}/routes.json`);
    expect(response.status()).toBe(200);

    // One flat array of every address the app answers for — public and private
    // together, because the server only needs to know whether a path exists,
    // not who may see it. The split between the two lives in vite.config.ts and
    // is what robots.txt and the sitemap are built from.
    const routes = (await response.json()) as string[];
    expect(Array.isArray(routes)).toBe(true);
    expect(routes).toContain('/login');
    expect(routes).toContain('/journal');
    expect(routes).toContain('/verify-email');
    expect(routes).not.toContain('/definitely-not-a-page');
  });
});

test.describe('security headers', () => {
  test('the CSP names the API origin it has to reach', async ({ request }) => {
    const response = await request.get(env.baseURL);
    const csp = response.headers()['content-security-policy'];
    expect(csp, 'no Content-Security-Policy at all').toBeTruthy();

    // The bundle knows the API URL at build time and the server does not, so
    // the Dockerfile re-declares the same build arg as API_ORIGIN. Get it wrong
    // and the browser blocks every API call the app makes — the app loads and
    // then does nothing, with the cause only in the console.
    expect(csp).toContain(env.apiOrigin);
    expect(csp).toMatch(/connect-src[^;]*'self'/);
  });

  test('script-src is self plus a hash, and never unsafe-inline', async ({ request }) => {
    const csp = (await request.get(env.baseURL)).headers()['content-security-policy']!;
    const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src'));

    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).toContain("'self'");
    // The hash is computed from the inline pre-paint theme snippet in
    // dist/index.html at boot, so editing that snippet is safe. Adding a
    // SECOND inline script, or reaching for 'unsafe-inline', is not.
    expect(scriptSrc).toMatch(/'sha256-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test('worker-src allows blob:, which confetti needs', async ({ request }) => {
    const csp = (await request.get(env.baseURL)).headers()['content-security-policy']!;
    // canvas-confetti builds its worker from a blob. Dropping this breaks the
    // celebration on a completed lesson and nothing else, which is exactly the
    // kind of thing nobody notices for a month.
    expect(csp).toMatch(/worker-src[^;]*blob:/);
  });

  test('the rest of the headers are there', async ({ request }) => {
    const headers = (await request.get(env.baseURL)).headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['strict-transport-security']).toBeTruthy();
    const csp = headers['content-security-policy']!;
    expect(csp).toMatch(/frame-ancestors[^;]*'none'|frame-ancestors[^;]*'self'/);
  });
});

test.describe('compression', () => {
  test('html, js and css come back brotli-compressed', async ({ request }) => {
    const index = await request.get(env.baseURL, {
      headers: { 'Accept-Encoding': 'br, gzip' },
    });
    expect(index.headers()['content-encoding']).toBe('br');

    // Precompressed into an in-memory cache at boot, so the quality-11 pass
    // never lands on a visitor's first paint. Without any of this the landing
    // page shipped ~520 kB uncompressed.
    const html = await index.text();
    const asset = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0];
    expect(asset, 'no hashed asset referenced from index.html').toBeTruthy();

    const script = await request.get(`${env.baseURL}${asset}`, {
      headers: { 'Accept-Encoding': 'br' },
    });
    expect(script.headers()['content-encoding']).toBe('br');
  });

  test('gzip is the fallback when brotli is not offered', async ({ request }) => {
    const response = await request.get(env.baseURL, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(response.headers()['content-encoding']).toBe('gzip');
  });

  test('a client that accepts nothing still gets the page', async ({ request }) => {
    const response = await request.get(env.baseURL, {
      headers: { 'Accept-Encoding': 'identity' },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-encoding']).toBeFalsy();
  });
});

test.describe('caching', () => {
  test('hashed assets are immutable and index.html is not', async ({ request }) => {
    const html = await (await request.get(env.baseURL)).text();
    const asset = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0]!;

    const assetResponse = await request.get(`${env.baseURL}${asset}`);
    // The rule keys off the `dist/assets/` DIRECTORY, not a filename regex.
    // The old regex wanted a dot before the hash — `index-BuXx0kl8.js` has a
    // dash — so it never matched and every asset was served `no-cache`.
    expect(assetResponse.headers()['cache-control']).toContain('immutable');

    const indexResponse = await request.get(env.baseURL);
    expect(indexResponse.headers()['cache-control']).toContain('no-cache');
  });
});

test.describe('SEO assets', () => {
  test('robots.txt points at the sitemap', async ({ request }) => {
    const response = await request.get(`${env.baseURL}/robots.txt`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toMatch(/Sitemap:/i);
  });

  test('the sitemap lists the public routes and leaks no private one', async ({ request }) => {
    const sitemap = await (await request.get(`${env.baseURL}/sitemap.xml`)).text();

    for (const path of ['/login', '/register', '/privacy', '/terms', '/kvkk']) {
      expect(sitemap, `sitemap should list ${path}`).toContain(path);
    }
    // Emitted from the same route arrays as robots.txt and routes.json, so a
    // route added to the wrong list shows up here first.
    for (const path of ['/dashboard', '/journal', '/admin', '/profile']) {
      expect(sitemap, `sitemap must not list ${path}`).not.toContain(`<loc>${path}`);
      expect(sitemap).not.toMatch(new RegExp(`<loc>[^<]*${path}</loc>`));
    }
  });

  test('the head carries the absolute-URL metadata', async ({ request }) => {
    const html = await (await request.get(env.baseURL)).text();

    // All of this is injected at build time and gated on VITE_SITE_URL,
    // because a wrong domain is worse than none.
    expect(html).toMatch(/<link rel="canonical"/);
    expect(html).toMatch(/property="og:url"/);
    expect(html).toMatch(/property="og:image"/);
    expect(html).toMatch(/name="twitter:image"/);
  });

  test('both structured-data blocks parse', async ({ request }) => {
    const html = await (await request.get(env.baseURL)).text();
    const blocks = [
      ...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    ].map((match) => JSON.parse(match[1]!) as { '@type': string });

    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const types = blocks.map((block) => block['@type']);
    expect(types).toContain('SoftwareApplication');
    expect(types).toContain('FAQPage');
  });

  test('both Sora subsets are preloaded, not just latin', async ({ request }) => {
    const html = await (await request.get(env.baseURL)).text();
    const preloads = [...html.matchAll(/rel="preload"[^>]*href="([^"]+woff2)"/g)].map(
      (match) => match[1]!,
    );

    // Turkish needs latin-ext. Preloading only `latin` leaves ş, ğ and ı to a
    // second request and a visible reflow on the landing page — in the app's
    // default language.
    expect(preloads.length).toBeGreaterThanOrEqual(2);
    expect(preloads.some((href) => /latin-ext/.test(href))).toBe(true);
    expect(preloads.some((href) => /latin(?!-ext)/.test(href))).toBe(true);
  });
});

test.describe('health', () => {
  test('/healthz answers without touching the API', async ({ request }) => {
    const response = await request.get(`${env.baseURL}/healthz`);
    expect(response.status()).toBe(200);
  });
});
