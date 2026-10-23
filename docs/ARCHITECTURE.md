# Architecture

Why the suite is shaped the way it is. Every section here is a decision that had
an alternative, and most of them were made after the alternative went wrong.

## The layers, and what each one is for

```
tests/api/            75  no browser        the HTTP contract
tests/ui/            136  Chromium ×2       the app, desktop and phone
tests/server/         17  request only      server.js: 404s, CSP, caching, SEO
tests/a11y/           19  Chromium + axe    twelve screens, two themes
tests/visual/         14  Chromium          screenshots, two themes, two widths
tests/api/rate-limit   6  own config        the limiters the rest of the run disables
tests/smoke-prod/     20  own config        the live site, read only
```

The order matters. A broken endpoint should fail in `tests/api` in twenty
seconds, not as nine confusing UI failures two minutes later — so anything
expressible as a request is tested as a request, and the UI tests are about the
things only a browser can show: what renders, what is reachable, what a redirect
does, what a form submits.

That is also why there is no mocking. Every test runs against the real API and
the real database. A mocked API tests the mock, and the two most interesting
defects this suite found — a CORS header the browser never received, and a
client-side race between two redirects — are both invisible with a mock in the
way.

## Getting a usable test account

The hardest constraint in this application, and the thing that shaped everything
else.

The backend has no test mode. Email verification is mandatory for every account
including admins, the raw verification token is returned exactly once into an
email body (the row stores `sha256(token)`), the entire feature set is behind
`requirePremium`, and a repository-wide search for `SKIP_`, `BYPASS`, `E2E` or
`TEST_` finds nothing but two `NODE_ENV` reads.

Three ways to get past that, and the suite uses all three, in order:

**1. One admin row, written directly.** `src/db/users.ts` inserts a single row
with `role: 'admin'`. This is unavoidable — the product genuinely cannot produce
a verified account without an inbox — and it is kept to exactly one account per
run. Two facts about the schema make it enough: `email_verified` defaults to
`true` (the column was added that way so a deploy would not lock out existing
rows; only `register` sets it false), and `requirePremium` short-circuits on
`role === 'admin'`, so no billing call is needed.

**2. Every other account over HTTP, as that admin.** `createPremiumUser()`
registers through `POST /auth/register`, then calls
`POST /admin/users/:id/verify-email` and
`PATCH /admin/users/:id/premium { lifetime: true }`. This is a deliberate choice
over inserting rows: it uses the same path a support agent would, and it means
those three endpoints are covered by every run that needs a user, for free.

The one thing the API cannot provide is the new user's id — `register` answers
`{ requires_verification, email }` and nothing else — so `findUserIdByEmail`
reads it from the database. That is the entire extent of the coupling.

**3. Minted tokens for the email links.** `src/db/tokens.ts` writes the hash the
server will look up and keeps the raw token for the URL. The alternative was
scraping the dev server's stdout for the `RESEND_API_KEY not set` log line, which
is both fragile and unavailable when Playwright owns the process. Minting
reproduces exactly what a user receives; it is the same one-way function either
way, and only the mail hop is skipped.

### Why accounts are worker-scoped

`adminWriteLimiter` allows thirty admin mutations a minute, keyed per admin — and
every fixture account in the run is minted by the same one. Creating an account
costs two of those calls, so a per-test account would meter the suite at fifteen
tests a minute per worker.

Per worker it is two calls for the whole run. The cost is that tests sharing a
worker share a journal, so anything asserting on a full listing calls
`clearTrades()` first. Tests within a worker run serially, so that is safe.

When several workers do ask at once, the fixtures **wait out the 429** rather
than failing. This is the same judgement the product itself makes: the CSV
wizard resends a chunk after `Retry-After` instead of leaving an import
half-landed. A 429 is a wait, not a refusal. Only 429 is retried — anything else
surfaces.

This is also why the test timeout is 90 seconds rather than 45: a test that
spends thirty of them being politely throttled is queueing, not hanging, and the
first version of the config reported that as the test being slow.

## The database

A database of its own, `trading_journal_e2e`, created by `npm run db:setup`.

`src/config/env.ts` refuses to load unless `DATABASE_URL` names exactly that,
on localhost. Not "contains `trading_journal`" — the one mistake worth
preventing is pointing this at the development database, whose name contains the
same string. The suite deletes user rows; that guard is the only thing between
a mistyped `.env` and someone's real journal.

Two reasons it is not the development database:

- The suite truncates. Obvious.
- The development database here had **drifted** from `schema.prisma`: missing
  `failed_login_count` and `locked_until`, carrying four columns `db push`
  wanted to drop. Those two missing columns are the account lockout, and the
  writes that use them are `.catch()`ed — so every lockout test would have
  passed while measuring nothing. A database created from the schema cannot
  drift by definition.

Cleanup is scoped to `%@tradelogie.test` rather than a `TRUNCATE`: the database
is disposable, but it also holds the seeded lesson and quiz content that the
quiz tests read the answer key out of, and a developer may have a hand-made
account in there.

### Timestamps

`src/db/tokens.ts` writes the UTC wall clock as a string, not a `Date`, and this
is not fussiness. Prisma maps `DateTime` to `timestamp(3)` *without* time zone
and reads every value back as UTC; node-postgres serialises a JS `Date` with the
local offset, which Postgres then discards for such a column. On a UTC+3 machine
a row written as a `Date` lands three hours ahead of where it was meant to.

An "an expired token is refused" test passed because of this — the token it
minted was two hours and fifty-nine minutes in the *future*. Writing the UTC
wall clock is what Prisma itself does, so the fixture and the application agree
about what a timestamp means.

## Built, not dev

The suite builds the web client and serves it with the project's own
`server.js`. Several tests are *about* that server — real 404 statuses from
`dist/routes.json`, the CSP whose `script-src` is a hash of the inline theme
snippet, brotli, `immutable` caching on `dist/assets/` — and none of it exists
under Vite's dev server.

`APP_MODE=dev` swaps in Vite for a faster edit loop and drops the
`server-contract` project, which would otherwise be asserting against something
that is not shipped. It is for a single-worker loop only: under several workers
the dev server intermittently fails to serve a lazy chunk, the app's error
boundary catches it, and the result looks exactly like a product crash. That
cost an hour of investigation once, and is in the README's known limits.

Three environment settings in `playwright.config.ts` are load-bearing:

- **`PORT=8081` for the API.** A backend started by hand for development may
  already hold 8080; a second one prints "Server running" while every request
  still goes to the first.
- **`ALLOWED_ORIGINS` and `APP_WEB_URL`.** Non-production CORS only adds `:5173`
  and `:4173` automatically. The built bundle is served from another port, and
  without naming it the browser blocks every API call the app makes — which
  presents as a completely broken application.
- **`VITE_SITE_URL`.** Without it the `seoAssets` plugin emits nothing,
  including `dist/routes.json`; `server.js` then falls back to answering 200 for
  every path, and the real-404 test passes for the wrong reason. The suite
  therefore also asserts the manifest exists.

## Selectors

The policy is in `src/pages/BasePage.ts` and the README. The short version: role
and accessible name first, `data-testid` only where semantics genuinely cannot
identify the thing, CSS class never.

The reason is not taste. A locator built on an accessible name fails when a
control stops being announceable, which is a real defect worth failing on. One
built on `.btn-primary` passes while the button is unreachable by keyboard and
invisible to a screen reader, then breaks when someone changes a colour — it
fails on the wrong things and passes on the wrong things.

Writing it that way turned up six controls in the app with no accessible name at
all. Those were fixed in the product. The suite is better for it and so is the
app, which is the argument for the policy in one sentence.

`data-testid` is used in two situations, both genuine:

- **A row among twenty identical ones.** Twenty "Delete" buttons are correctly
  named and indistinguishable.
- **A control the layout renders twice.** The CSV wizard draws its mapping
  fields as a table *and* a stack simultaneously (one is `sm:hidden`, the other
  `hidden sm:block`), bound to the same state. A plain `select` query matches
  every field twice, and the two are indistinguishable by role, name or
  position. Each carries a layout-specific id and the page object resolves to
  whichever is painted.

### Strings

`src/utils/strings.ts` is generated from the app's own dictionaries by
`npm run sync:i18n`, and `tests/ui/i18n-sync.spec.ts` regenerates and compares
so drift is one loud failure rather than eight quiet ones.

Hand-typed literals do not work here. The app defaults to Turkish and never
reads `navigator.language`, so English literals match nothing by default; the
Turkish dictionary uses the typographic apostrophe (`CSV’den`, not `CSV'den`),
which is invisible in a failing diff; and several strings interpolate
(`Import {count} trades`), so no literal matches at all. `pattern()` turns those
into regexes.

## The analytics oracle

There is no analytics endpoint — `lib/analytics.ts` computes the equity curve,
win rate, profit factor and by-symbol table in the browser from `/trades`. So a
fixed set of trades has exactly one correct set of statistics, and
`src/fixtures/data.ts` works them out by hand with the arithmetic in a comment.

The alternative would be computing the expected values in the test, which means
a second implementation of the same arithmetic — and a second implementation
agrees with the first one's bugs. A hand-checked table does not. This is the one
place in the suite where the expected value is a literal on purpose.

The figures are read through `getByRole('group', { name })`, which works because
`StatCard` now associates its label with its value. Before that, the only way to
reach a number was to match a Tailwind class or count siblings — and the fix
made the dashboard navigable by screen reader at the same time.

## Accessibility: a baseline, not zero

`a11y-baseline.json` records what is already broken, with a node count per rule
per screen. A new violation fails; so does an additional node under an existing
rule.

Zero would have been dishonest and short-lived. A real application that has
never been audited has violations, and a suite that is red on all of them from
day one is switched off within a week. A baseline makes the gate meaningful
while every line of the file stays a visible, countable to-do — and six lines
came off it while this suite was being written.

The node count is the important part. An allowlist of rule ids alone would
accept a seventh unlabelled input on a page that already had six, which is how
a baseline quietly becomes a licence.

Entries are keyed by `screen:theme`, because contrast is a per-theme property:
keyed by screen alone, the dark run reports the light run's accepted violation
as stale and the light run accepts it where it does not occur.

`best-practice` rules are deliberately excluded. They flag things like heading
order — worth fixing, but they would bury the ones that stop someone using the
page.

## Visual regression

### Baselines are generated in CI, on Linux, and nowhere else

This is the thing most visual-regression setups get wrong, and the symptom is a
suite that is red for everyone except whoever last ran `--update-snapshots`.

Font rasterisation differs per platform — different hinting, different subpixel
rounding — so a baseline taken on Windows fails on a Linux runner on every pixel
of every glyph. So: `snapshotPathTemplate` includes `{platform}`, `.gitignore`
excludes the `darwin` and `win32` directories, and `.github/workflows/visual.yml`
is the only thing that writes the committed set. It opens a pull request rather
than committing, because a changed baseline is a change to what the app is
supposed to look like and deserves a human looking at the diff.

### Four things are neutralised, each for a reason

1. **Animation** — `animations: 'disabled'` plus a CSS override, because the app
   also has `animate-[fadeIn]` on modals and `transition` on dozens of hover
   states. The caret is made transparent too; it blinks.
2. **Charts** — masked, not hidden. recharts and klinecharts lay out from a
   measured container and animate on mount, so they differ by a pixel or two
   every render. A mask proves the chart is there and the right size without
   asserting its anti-aliasing.
3. **Time** — `clock.install` at a fixed instant. Every relative date and the
   streak badge move with the real clock, so a baseline taken today would fail
   tomorrow for no reason.
4. **Fonts** — `document.fonts.ready` is awaited. The fallback face has
   different metrics, so a screenshot taken before Sora arrives is a different
   *layout*, not a different colour.

## The rate limiters

The main run sets `DISABLE_RATE_LIMIT`, a flag added to the backend for this and
hard-gated on `NODE_ENV` so production ignores it whatever the environment says.
Without it the global ceiling of 120 requests a minute per IP is reached within
seconds of a parallel UI run, and the suite spends its time proving it has been
throttled.

That would leave a security control untested, so the limiters get their own
configuration: a second backend on its own port with the flag absent, run
serially with one worker, because the buckets are per-IP and in memory and two
workers would spend each other's budget.

Three things about that file are forced by what it tests:

- **Order is the file's order.** `globalLimiter` covers every request any test
  makes, so the cheap tests run first and the one that exhausts the budget runs
  last.
- **A limiter is identified by *when* it fires, not by its code.** Every limiter
  answers 429 with `code: 'RATE_LIMITED'`, so the code cannot tell you which one
  you hit. The counts can: 5 for email, 10 for auth failures, 120 for
  everything. An earlier-than-expected 429 is reported as a failure rather than
  quietly passing — which is exactly what the first version of this file did.
- **The global ceiling is measured through `RateLimit-Remaining`.** Counting to
  120 does not work when the window is a minute shared with every other test in
  the file; waiting it out means a blind sixty-second sleep. Asking the limiter
  how much is left turns a brittle count into an exact assertion *and* checks
  that the advertised budget is the enforced one — a header that lied would be
  worse than no header, since a well-behaved client paces itself by it.

The per-account lockout is untouched by the flag: it is DB-backed and counts per
user, which is what makes it testable while the suite runs.

## Load testing

`k6/api-load.js` ramps to ten virtual users against `GET /users/me` and
`GET /trades` — the two calls every signed-in page waits on. Modest on purpose:
the interesting question for a single container in front of one Postgres is not
throughput, it is whether those two stay inside a few hundred milliseconds while
several people use the app.

The host is checked twice, in the launcher and at the top of the script, and the
run aborts rather than warns. A load script is one environment variable away
from being a denial-of-service tool against your own users, and the mistake is
easy: copy a command out of a README, forget to change the host. That is also
why the workflow is `workflow_dispatch` only — a load profile that runs
automatically will eventually run against something it should not.

## Running in CI

`e2e.yml` checks out all three repositories, starts Postgres as a service, and
lets Playwright's `webServer` do the rest — so CI runs the same three commands a
person runs locally.

The application repositories are private and the default `GITHUB_TOKEN` is
scoped to this one, so they are read over SSH with a **read-only deploy key per
repository**. A personal access token was the obvious choice and is the worse
one: it would be a single credential with read access to everything the account
can see, created by hand in a browser and renewed by hand when it expires. A
deploy key is scoped to exactly one repository, read-only, has no expiry, and
installs from the CLI — `gh api repos/.../keys` to add the public half,
`gh secret set` for the private half. If one leaks it reads one repository.

`smoke-prod.yml` is the one that needs no secret at all, and it is the more
useful badge. It imports nothing from `src/` — not even the env config, which
exists to refuse databases and has no business being loaded by a run that must
never touch one — and every assertion is a GET a crawler could make. It is
incapable of creating an account or spending anyone's rate limit, which is what
makes it safe to point at production twice a day.

Reports are published to GitHub Pages by `pages.yml`, from the artifacts of the
run that triggered it rather than from a fresh run: the point is to publish what
actually happened. Both reporters go up because they answer different questions
— Playwright's has the trace viewer for a single failure, Allure aggregates
flakiness and duration across runs.
