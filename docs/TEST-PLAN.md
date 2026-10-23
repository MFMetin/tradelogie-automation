# Test plan

What is covered, at which layer, and why there rather than somewhere else.

The column that matters is **Why this layer**. Anything expressible as a request
is tested as a request: a broken endpoint should fail in twenty seconds in
`tests/api`, not as nine confusing UI failures two minutes later. A UI test
earns its cost only when the thing under test is something only a browser can
show — what renders, what is reachable, what a redirect does.

---

## 1. Authentication

| Risk | Layer | Test | Why this layer |
|---|---|---|---|
| Registration hands out a session before verification | api | `auth.spec` → answers `requires_verification` and never a session | It happened: auto-verifying an `ADMIN_EMAILS` address gave admin to whoever claimed it first. The assertion is on the response body, so a browser adds nothing. |
| An unverified account cannot tell why it cannot sign in | api + ui | `403 EMAIL_NOT_VERIFIED`; the login page offers resend | The code is an API fact; *which affordance appears* is a UI fact, and showing "wrong password" instead would be a dead end — no number of retries fixes an unverified account. |
| Brute force | api | five wrong passwords → `429 ACCOUNT_LOCKED` + `Retry-After`; the correct password is still refused while locked | Per-account and DB-backed. The "correct password still refused" case matters: checked after the compare, the lock would tell an attacker when it had guessed right. |
| The lockout wait is unreadable | ui | the login page shows "try again in 5 minutes" | **Only** visible in a browser — the number arrives in a response header the browser has to be allowed to read. This test is what found the missing CORS `exposedHeaders`. |
| A stolen refresh token keeps working | api | replay revokes the whole family; a random string revokes nothing | Pure protocol. The second half matters as much as the first: reuse detection firing before the signature check would let anyone end a stranger's sessions. |
| Changing a password signs you out | api | change-password answers a fresh pair; the old one is dead | The server revokes every refresh token including the caller's, so the client must save the new pair. Skip that and a user is signed out for changing their own password. |
| The login form is an account-existence oracle | api + ui | resend and reset answer identically for a stranger; the login error is the same sentence | Byte-identical responses are an API assertion; that the *page* does not differentiate is a UI one. |
| A reset link cannot be used twice, or late | api | an expired token is refused; a spent one is refused | Needs a minted token, which is a fixture concern, not a browser one. |
| A bookmarked page is lost on sign-in | ui | `/journal` → login → back to `/journal` | Only expressible in a browser: two client-side redirects racing. **Found a real bug** — `PublicOnlyRoute` won and `state.from` had been dead since it was added. |

## 2. The premium gate

| Risk | Layer | Test | Why this layer |
|---|---|---|---|
| A new feature is mounted without the gate | api | every gated mount is listed and checked | Listed, not sampled: the gate is applied per router, so a router mounted without it is precisely the regression. A spot check of two would miss it. |
| A lapsed subscription keeps access | api | a backdated `premiumUntil` is refused | `requirePremium` reads the flag *and* the date; trusting the flag alone lets every lapsed subscriber back in. |
| Support cannot see what a customer sees | api | an admin passes without `isPremium` | Deliberate behaviour, so it is pinned rather than left to chance. |
| The paywall is unreachable from behind itself | api + ui | `/billing`, `/profile`, `/feedback` stay open | A user who cannot read their own profile cannot be told why they are stuck. |
| Editing localStorage buys access | ui + api | a forged cached profile is corrected before a single trade is requested; the server refuses regardless | The client-side half needs a browser. The API half needs none, and is the one that actually matters. |

## 3. The journal

| Risk | Layer | Test | Why this layer |
|---|---|---|---|
| Net P&L is wrong | ui + api | a trade logged in the form shows `pnl - fee`; the stored row agrees | The number on screen and the number in the database are two different claims; both are checked in one test. |
| Which side is selected is invisible | ui | `aria-pressed` on the side and status toggles | Could not be tested at all before: the selection lived only in a Tailwind class. The fix made it both testable and announceable. |
| Form state contradicts itself | ui | `status: open` disables exit price and close time | Interaction, so a browser is required. |
| One user can reach another's trades | api | read, edit, delete and bulk-delete are all refused | The most important tests in the suite, and none of them need a browser. Bulk delete is checked separately because filtering by id alone would be a way to wipe anyone. |
| A trade can be reassigned to another user | api | `userId` in a PUT body is dropped | `userId` is not a schema key, so the attempt is dropped rather than deleted after the fact. |
| CSV imports vanish from the account filter | ui | the CSV bucket filters, and holds exactly the imported row | `CSV_SCOPE` exists because a CSV row has a broker but no `sourceAccountId`. Without it, such a row matches neither "Manual" nor any account and appears only under "All". Only visible through the filter. |
| Edit and delete are unreachable on a phone | ui-mobile | both are visible, and at least 40px tall | The reason the card layout exists. The table's actions were in a horizontal scroller and `opacity-0` until hover — neither of which a phone has. |
| A comma decimal is a 500 | api | `entryPrice: "1,25"` → 400 with a message | It used to hand the body to Prisma untouched. A 500 tells the caller nothing. |
| Any column is writable | api | invented fields are dropped | Same regression, same fix. |

## 4. CSV import

| Risk | Layer | Test | Why this layer |
|---|---|---|---|
| A known broker export is not recognised | ui | the MT5 preset is detected and Continue is live | The preset matches on normalised headers; a miss silently turns every other import test into a test of the fallback. |
| An unknown export cannot be imported | ui | column guessing fills what it can, the rest is mapped by hand, three rows land | **The case the whole wizard exists for.** Presets are a shortcut, never a requirement. |
| Continue lets a file through without the required fields | ui | unmapping `symbol` disables it; re-mapping re-enables it | Pure interaction. |
| A fee is added instead of subtracted | ui + api | MT5's `-1.20` commission is stored as `1.20` | A sign error here flatters every imported trade, in the direction nobody questions. |
| One bad row costs the whole file | ui + api | two land, the bad ones are rejected individually | The API half asserts the `{row, message}` index that lets the wizard point at a line. |
| A re-import duplicates everything | ui + api | the button reads "Import 0 trades" and is disabled; the server dedupes too | Two independent halves: the client's is instant and makes the preview honest, the server's survives two tabs importing at once. |
| A large file is posted as one request | ui | a 601-row file is exactly `[500, 101]` | Asserted on the actual request bodies. Only observable with a browser in the loop. |
| A mapping is lost between sessions | ui | a saved mapping is offered next time | It is stored as header *names*, not indexes, so it survives an export that gained a column. |
| Closing mid-import loses work silently | ui | Escape asks first | Interaction. |

## 5. Analytics

| Risk | Layer | Test | Why this layer |
|---|---|---|---|
| The numbers are wrong | ui | every headline figure against a hand-computed five-trade set | There is no analytics endpoint — it is all computed in the browser, so the browser is the only place to check it. The expected values are hand arithmetic, not a second implementation. |
| A losing account is shown as winning | ui | a loss-only set nets `-$310.00` and 0.0% | The sign survives `avgLoss` being stored positive, negated at display, and `fmtCurrency` adding its own. |
| A division by zero renders as NaN | ui | an all-winning set shows `∞` | It has rendered "Infinity" and "NaN" before. |
| Two screens disagree | ui | the dashboard and analytics page report the same net | Both read the same `computeStats`; disagreement means one is scoping differently. |

## 6. Education and XP

| Risk | Layer | Test | Why this layer |
|---|---|---|---|
| The answer key ships with the questions | api | `correctIndex` and `correctOptionIndex` are both absent | The reason grading moved server-side. With the key in the page, the score was the client's to decide. |
| XP can be collected without answering | api | a forged `{ score: 100 }` with wrong answers scores 0 and awards nothing | **This exact payload used to collect the XP for every lesson without opening one.** The highest-value test in the file. |
| XP can be farmed by resubmitting | api | the second submission is `alreadyCompleted` with `xpAwarded: 0` | Resubmitting is allowed — a lesson can be revised — but it must not pay twice. |
| A partial submission scores full marks | api | one correct answer out of several scores under 100 | |
| Grading is broken | api | a fully correct submission scores 100 and the XP lands on the profile | The answer key is read from the seeded content, which is the one place the suite deliberately looks behind the API — and the point, since the key is stripped from every response. |

## 7. Routing and the shell

| Risk | Layer | Test | Why this layer |
|---|---|---|---|
| A route crashes | ui | every route renders **and** the crash screen is absent | The crash screen renders inside `<main>`, so "something rendered" is true of it. This assertion is what caught a completely dead `/analytics`. There is no error tracking in this app by choice, so noticing is the suite's job. |
| A typo is silently swallowed | ui + server | `*` renders the 404 page without redirecting; the server answers a real 404 status | The status is invisible in a browser and only matters to a crawler, so it is a server test. The rendering is a UI one. |
| `/admin` confirms itself to a non-admin | ui | a non-admin gets the 404 page, not a bounce to the dashboard | A redirect to the dashboard would confirm there is something there. |
| A legal page is unreachable while signed in | ui | all four render in both states | They sit outside `PublicOnlyRoute` for the same reason the email links do. |
| A preference does not persist | ui | theme survives a reload and is written to localStorage; language flips the UI, `html[lang]` and storage | The theme is read by a pre-paint snippet before React exists, so persistence is the whole feature. |
| The streak reads zero | ui + api | the badge shows at least day one | It read 0 for every account once, because the endpoint that existed was never called. There is still no streak endpoint — the server counts the day on the three calls that already return a user. |

## 8. `server.js`

Everything here is invisible in a browser until it matters, which is exactly why
it needs a test.

| Risk | Test | Consequence if it regresses |
|---|---|---|
| Every address returns 200 | `/not-a-page` → 404; real routes → 200; `routes.json` exists | Crawlers index every typo. The manifest check matters because a missing manifest makes `server.js` fall back to 200 and the 404 test pass for the wrong reason. |
| The CSP blocks the API | `connect-src` names the API origin | The deployed app loads and then does nothing at all. The single most expensive way for this to break. |
| Inline script is allowed wholesale | `script-src` is `'self'` + a `sha256-` hash, with no `'unsafe-inline'` or `'unsafe-eval'` | The hash is computed from `dist/index.html` at boot, so editing the theme snippet is safe; adding a second inline script is not. |
| Confetti stops working | `worker-src` allows `blob:` | canvas-confetti builds its worker that way. Nobody would notice for a month. |
| Compression is off | brotli, with gzip as fallback and a working `identity` path | The landing page ships ~520 kB instead of ~135 kB. |
| Assets are re-downloaded every visit | hashed assets are `immutable`; `index.html` is `no-cache` | The old rule wanted a dot before the hash — `index-BuXx0kl8.js` has a dash — so nothing matched and every asset was `no-cache`. |
| SEO metadata is wrong or missing | canonical, `og:*`, `twitter:image`, two valid JSON-LD blocks, both Sora subsets preloaded | All of it is gated on `VITE_SITE_URL`, because a wrong domain is worse than none. Preloading only `latin` leaves ş, ğ and ı to a second request — in the app's default language. |
| Private routes are published | the sitemap lists public routes only | Invites crawlers to pages that bounce them straight out, and publishes the shape of the app for nothing. |

## 9. Accessibility

Twelve screens, both themes, gated on a baseline — see
[ARCHITECTURE.md](ARCHITECTURE.md#accessibility-a-baseline-not-zero) for why a
baseline and not zero.

Scanned: landing, login, register, legal, 404, dashboard, journal with trades,
analytics, profile, billing, the trade form, both import-wizard steps, and the
delete confirmation. Dialogs are scanned **open**, because a modal is where
labelling and focus problems live and the page behind it already has its own
scan.

Found and fixed in the app: six controls with no accessible name, four dialogs
with no role or name, a loader that announced nothing, a stat tile whose number
had no label, a focusable `aria-hidden` backdrop, and a language switch that
failed WCAG 2.5.3. Remaining in the baseline: four light-theme contrast failures
in the journal toolbar, which need a design-token change.

## 10. Visual regression

Eight screens × themes × widths, including the phone journal — the layout three
recent commits were about, and the only thing that would notice the table coming
back. Baselines are Linux-only and generated in CI; see
[ARCHITECTURE.md](ARCHITECTURE.md#visual-regression).

## 11. Load

`GET /users/me` and `GET /trades` — the two calls every signed-in page waits on
— against 250 seeded trades, ramping to ten virtual users. Thresholds:
`http_req_failed < 1%`, `/trades` p95 under 500ms, `/users/me` p95 under 250ms.
500ms is where the journal stops feeling instant, since it shows a loader until
`/trades` answers.

---

## Deliberately not covered

Worth stating, because a plan that implies total coverage is lying.

- **Exchange connections** (`/connected-accounts/*`). Signing a Binance request
  needs a real API key, and provisioning a MetaApi terminal costs money. Testing
  it would mean mocking the venue, which tests the mock. The credential *forms*
  are covered by the a11y scan; the sync itself is not.
- **The MT5 bridge.** Needs a Windows VPS running a MetaTrader terminal.
- **Email delivery.** The suite mints tokens instead. That Resend is called at
  all is not asserted — only that the request succeeds and reveals nothing about
  whether the address exists.
- **Market excursions** (`/market/excursions`). Answers depend on an upstream
  price feed and a provider quota, so an assertion on the numbers would be an
  assertion about the market. The *caching* behaviour would be worth testing and
  is not yet.
- **Drag-and-drop CSV upload.** The drop zone is a plain `<div>` with no role —
  a gap in the component, noted rather than faked.
- **Browsers other than Chromium.** Firefox and WebKit would roughly triple the
  run for a client with no browser-specific code. Worth adding to the nightly
  job if that stops being true.
- **The admin panel's own UI.** Served as static files from the backend, and a
  different application; the admin *endpoints* the fixtures use are covered.
