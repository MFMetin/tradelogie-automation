# Tradelogie — test automation

[![e2e](https://github.com/MFMetin/tradelogie-automation/actions/workflows/e2e.yml/badge.svg)](https://github.com/MFMetin/tradelogie-automation/actions/workflows/e2e.yml)
[![smoke (production)](https://github.com/MFMetin/tradelogie-automation/actions/workflows/smoke-prod.yml/badge.svg)](https://github.com/MFMetin/tradelogie-automation/actions/workflows/smoke-prod.yml)

End-to-end, API, accessibility and visual-regression tests for
[Tradelogie](https://tradelogie.com) — a gamified trading journal (React 19 +
Vite client, Express 5 + Prisma API).

**287 tests** across eight Playwright projects — 261 of them in the default
run, which takes about 90 seconds. The suite starts both halves of the
application itself, so that is one command on a clean machine.

> 🇹🇷 Türkçe anlatım aşağıda: [Türkçe](#türkçe)

---

## What it covers

| Project | Tests | What it is |
|---|---|---|
| `api` | 75 | The HTTP contract the UI is written against. No browser, so it is the fastest layer and the first to fail. |
| `ui-desktop` | 68 | The app at 1440×900, driven through page objects. |
| `ui-mobile` | 68 | The same tests on a Pixel 5. The journal renders cards instead of a table below `lg`, and the nav becomes a drawer. |
| `server-contract` | 17 | `server.js` itself: real 404 statuses, CSP, brotli, `immutable` caching, sitemap, structured data. |
| `a11y` | 19 | axe-core over twelve screens, in both themes, gated on a baseline. |
| `visual` | 14 | Screenshots of eight screens, both themes, desktop and phone. |
| `rate-limit` | 6 | The limiters, which the rest of the run switches off. Own config, own backend. |
| `smoke-prod` | 20 | Read-only checks against the live site. No secrets, no sign-in, no writes. |

Plus a [k6](k6/api-load.js) load profile for the two endpoints every page waits
on.

## Running it

```bash
cp .env.example .env          # the defaults assume a local Postgres
npm install
npx playwright install chromium
npm run db:setup              # creates trading_journal_e2e, pushes the schema, seeds content

npm test                      # everything
npm run test:api              # ~20s, no browser
npm run test:ui               # desktop + phone
npm run test:smoke            # read-only, against the live site
npm run test:ratelimit        # own backend, limiters on
npm run report                # open the last HTML report
```

The suite builds the web client and serves it with the project's own
`server.js`, because several tests are about that server. `APP_MODE=dev` swaps
in Vite for a faster edit loop and drops the `server-contract` project, which
would have nothing to assert against.

Both application repositories are expected as siblings
(`../trading_journal_web`, `../trading_journal_backend`); override with
`WEB_REPO` and `API_REPO`.

## The three things worth reading

### 1. How a usable test account gets made

This is the hard problem in this application, and it shapes the whole fixture
layer. Email verification is mandatory for everyone, the raw verification token
exists only inside an email (the row stores its SHA-256), the entire app is
premium-gated, and there is no bypass flag anywhere in the backend.

So accounts are built in three layers, each using the door the one below opened:

1. **One admin row, written directly** ([`src/db/users.ts`](src/db/users.ts)).
   Unavoidable: the product cannot produce a verified account without an inbox.
   `email_verified` defaults to true in the schema and `role: 'admin'` passes
   `requirePremium` unconditionally, so a single INSERT is enough.
2. **Every other account over HTTP, as that admin**
   ([`src/fixtures/users.ts`](src/fixtures/users.ts)) — register, then
   `POST /admin/users/:id/verify-email`, then
   `PATCH /admin/users/:id/premium`. The fixtures exercise the product's own
   endpoints instead of writing rows behind its back, which also means those
   three stay covered by every run that needs a user.
3. **Verification and reset links are minted**
   ([`src/db/tokens.ts`](src/db/tokens.ts)) by writing the hash the server will
   look up and keeping the raw token for the URL. Same one-way function; only
   the mail hop is skipped. No scraping a dev server's stdout.

Accounts are **worker-scoped**, not per-test: `adminWriteLimiter` allows thirty
admin mutations a minute and creating one costs two. When several workers ask at
once the fixtures **wait out the 429** rather than failing on it — the same
reasoning the product's CSV wizard uses when it resends a chunk.

### 2. The selector policy

Every locator in [`src/pages/`](src/pages) is built in this order:

1. `getByRole` with an accessible name
2. `getByLabel`
3. a semantic attribute the markup already needs (`type`, `autocomplete`)
4. `data-testid`, only where semantics genuinely cannot identify the thing
5. a CSS class — **never**

This is not style. A locator built on an accessible name fails when a control
stops being announceable, which is a real defect. One built on `.btn-primary`
passes while the button is unreachable by keyboard and invisible to a screen
reader, and then breaks when someone changes a colour.

Writing it that way surfaced six controls in the app with no accessible name at
all. They were fixed in the product, not worked around here.

`data-testid` is used in exactly two situations, both real: one row among twenty
identically-labelled ones, and a control the layout renders **twice** — the CSV
wizard draws its mapping fields as a table and a stack simultaneously, so a
plain `select` query matches every field two times.

Selector strings come from the app's own dictionaries via `npm run sync:i18n`,
and [a test fails if they drift](tests/ui/i18n-sync.spec.ts). The app defaults to
Turkish, its Turkish copy uses the typographic apostrophe (`CSV’den`), and
several strings interpolate — hand-typed literals pass on the machine that wrote
them and nowhere else.

### 3. The analytics oracle

There is no analytics endpoint. The equity curve, win rate, profit factor and
by-symbol table are all computed in the browser from `/trades`. So a fixed
five-trade set has exactly one correct set of statistics, and they are worked out
by hand once in [`src/fixtures/data.ts`](src/fixtures/data.ts):

```
+200-5 = +195   BTCUSDT  win      wins 3, losses 2    -> 60.0%
+150-5 = +145   BTCUSDT  win      gross profit 415
-100-5 = -105   ETHUSDT  loss     gross loss    310
 +80-5 =  +75   ETHUSDT  win      profit factor 1.34
-200-5 = -205   XAUUSD   loss     net          +$105.00
```

Checking the page against a hand-computed table rather than a second
implementation of the same arithmetic is the difference between a test and a
tautology.

## What it found

Nine real defects, all fixed in the application rather than worked around here.

| What | Why it mattered |
|---|---|
| Signing in from a redirect threw the destination away | `PublicOnlyRoute` won the race against `LoginPage`'s own navigate, so `state.from` had been dead since it was added. Open a bookmarked `/journal`, sign in, land on the dashboard. |
| `Retry-After` was never exposed through CORS | It is not a CORS-safelisted response header and the API is on another origin, so the browser never handed it over. The client had the code to render "try again in 5 minutes" and always showed the vague fallback instead. |
| An unknown API path answered Express's HTML error page | `apiErrorMessage()` reads `{ message }` off the body, so a mistyped endpoint surfaced as a generic error with the real cause only in the network tab. |
| Six form controls had no accessible name | Login and register built `<label>` with no `htmlFor` over inputs with no id. |
| The trade form's side/status toggles had no state | Which one was selected lived only in a Tailwind class — two identical buttons to a screen reader. |
| Four dialogs were modal in appearance only | No `role`, no accessible name; one of them deletes a thousand trades. |
| `StatCard`'s numbers had no label | Label, value and sub-line were three unconnected paragraphs. |
| `PageLoader` announced nothing | Every route's Suspense fallback, so the most common thing in the app to be waiting in front of. |
| The language switch failed WCAG 2.5.3 | Reads "EN", labelled "Switch to English" — so "click EN" matched nothing by voice. |

## Four of my own tests were wrong

Each one passed while proving nothing, which is worse than failing. They are
documented where they happened, because the mistakes are more instructive than
the tests:

- **"every route renders"** passed against a completely dead `/analytics`.
  `AppErrorBoundary`'s crash screen renders inside `<main>`, so "the route
  rendered something" was true of it. Every route test now asserts the crash
  screen is *absent*.
- **"3 rows imported"** passed at the *columns* step — the wizard's stepper
  renders "3 Preview" on every screen. Result assertions are exact strings now.
- **"sign-out works"** passed while the fixture's `addInitScript` re-seeded the
  tokens on the next navigation. Sessions come from `storageState` now, which is
  applied once per context rather than on every page load.
- **The rate-limit tests** "passed" in 6ms because every limiter answers 429 with
  the same code and the shared 120/min ceiling got there first. They identify a
  limiter by *when* it fires now (5 for email, 10 for auth failures), and the
  global one reads `RateLimit-Remaining` instead of guessing — which also checks
  the advertised budget is the enforced one.

## Known limits

- **One test is flaky under full load, at roughly one run in four.** The CSV
  wizard's manual-mapping test (`ui-mobile`) occasionally times out when all six
  projects are running at once; it passes ten times out of ten in isolation and
  on three of four full runs. CI retries twice, which is the right treatment for
  this class, but it is a known flake rather than a solved one — the suspected
  cause is a fixture waiting out a 429 inside a test that also has nine
  sequential `selectOption` calls to make.
- **`APP_MODE=dev` is for a single-worker edit loop, not a parallel run.** Under
  several workers the Vite dev server intermittently fails to serve a lazy
  chunk, and the app's error boundary catches it — which looks exactly like a
  product crash. The default (`build`) does not have this problem.
- **Visual baselines are generated in CI, on Linux, and nowhere else.** Font
  rasterisation differs per platform, so a baseline taken on Windows fails on
  the runner on every pixel of every glyph. `.gitignore` excludes the `darwin`
  and `win32` directories; [`visual.yml`](.github/workflows/visual.yml) is the
  only thing that writes the committed set.
- **`a11y-baseline.json` has one entry**: four light-theme contrast failures in
  the journal toolbar. Recorded so a *fifth* fails the build — not accepted as
  correct. Six entries came off that file while the suite was being written.
- **CI reads the application repositories over SSH**, with a read-only deploy
  key per repository (`WEB_REPO_DEPLOY_KEY`, `API_REPO_DEPLOY_KEY`). A personal
  access token would have worked too, but it would be one credential with read
  access to everything the account can see, needing manual creation and manual
  renewal. A deploy key is scoped to one repository, read-only, never expires,
  and can be installed entirely from the CLI.
- The CSV wizard's **drag-and-drop** path is not automatable: the drop zone is a
  plain `<div>` with no role. That is a gap in the component, noted rather than
  faked.
- `npm run k6` needs the [k6 binary](https://grafana.com/docs/k6/latest/set-up/install-k6/)
  and a backend started separately. It refuses to run against anything but
  localhost, twice.

## Layout

```
src/
  config/env.ts        typed env, and the guard that refuses any database but the local one
  api/                 typed clients for the endpoints the tests use
  db/                  the three things the API genuinely cannot do: bootstrap, id lookup, token minting
  fixtures/            global setup/teardown, Playwright fixtures, test data
  pages/               page objects, one per screen
  utils/               i18n, a11y baseline, screenshot stabilisation
tests/
  api/ ui/ server/ a11y/ visual/ smoke-prod/
fixtures-data/         generated broker CSVs (npm run fixtures:csv)
k6/                    the load profile
docs/                  ARCHITECTURE.md, TEST-PLAN.md
```

---

<a id="türkçe"></a>

# Türkçe

[Tradelogie](https://tradelogie.com) için uçtan uca, API, erişilebilirlik ve
görsel regresyon test altyapısı. Sekiz Playwright projesinde **287 test** —
varsayılan koşuda 261 tanesi, yaklaşık 90 saniyede. Suite uygulamanın iki
yarısını da kendisi ayağa kaldırıyor, yani temiz bir makinede tek komutla
koşuyor.

## Koşturmak

```bash
cp .env.example .env
npm install
npx playwright install chromium
npm run db:setup      # trading_journal_e2e veritabanını kurar, şemayı uygular, içeriği seed eder

npm test              # her şey
npm run test:api      # ~20s, tarayıcısız
npm run report        # son HTML raporunu açar
```

## Üç önemli tasarım kararı

**1. Test kullanıcısı nasıl üretiliyor.** Bu uygulamada işin zor kısmı bu.
E-posta doğrulaması herkes için zorunlu, ham doğrulama token'ı yalnızca
e-postanın içinde var (veritabanında SHA-256'sı duruyor), tüm uygulama premium
duvarının arkasında ve backend'de bunu atlayan hiçbir bayrak yok.

Bu yüzden hesaplar üç katmanda üretiliyor: **tek bir admin satırı** doğrudan
veritabanına yazılıyor (başka yolu yok — ürün, gelen kutusu olmadan doğrulanmış
hesap üretemiyor); **diğer bütün hesaplar o admin olarak HTTP üzerinden**
üretiliyor, yani fixture'lar ürünün kendi uçlarını kullanıyor; **doğrulama ve
şifre sıfırlama linkleri** ise sunucunun arayacağı hash'i yazıp ham token'ı URL
için saklayarak basılıyor — aynı tek yönlü fonksiyon, sadece e-posta adımı
atlanıyor.

Hesaplar test başına değil **worker başına**: `adminWriteLimiter` dakikada 30
admin işlemi veriyor ve bir hesap iki tanesine mal oluyor. Birden fazla worker
aynı anda istediğinde fixture'lar 429'u **hata saymıyor, bekliyor** — ürünün
CSV sihirbazının chunk'ı yeniden gönderirken yaptığının aynısı.

**2. Selector politikası.** Sırayla: `getByRole` + erişilebilir ad → `getByLabel`
→ `type`/`autocomplete` gibi zaten gerekli olan semantik attribute →
`data-testid` (sadece semantiğin gerçekten yetmediği yerde) → CSS class
**asla**.

Bu bir üslup tercihi değil. Erişilebilir ada dayanan bir selector, kontrol
duyurulamaz hale geldiğinde kırılır — ki bu gerçek bir hatadır.
`.btn-primary`'ye dayanan selector ise buton klavyeyle erişilemezken ve ekran
okuyucuya görünmezken geçmeye devam eder, sonra biri rengi değiştirince kırılır.

Bu şekilde yazmak uygulamada **erişilebilir adı hiç olmayan altı kontrol**
ortaya çıkardı. Hepsi üründe düzeltildi, burada etrafından dolanılmadı.

**3. Analytics oracle'ı.** Analytics için endpoint yok — equity curve, kazanma
oranı, profit factor, sembol bazlı tablo, hepsi tarayıcıda `/trades`'den
hesaplanıyor. Dolayısıyla sabit beş işlemlik bir setin tek bir doğru cevabı var
ve o cevap `src/fixtures/data.ts` içinde elle hesaplanmış. Sayfayı, aynı
aritmetiğin ikinci bir uygulamasıyla değil elle hesaplanmış bir tabloyla
karşılaştırmak, testi totolojiden ayıran şey.

## Ne buldu

Dokuz gerçek hata — hepsi üründe düzeltildi. En önemlileri:

- **Yönlendirmeden sonra giriş yapan kullanıcı istediği sayfaya gitmiyordu.**
  `PublicOnlyRoute`, `LoginPage`'in kendi `navigate`'ini yarışta geçiyordu, yani
  `state.from` eklendiği günden beri ölüydü. Yer imindeki `/journal`'ı açıp giriş
  yapan kullanıcı dashboard'a düşüyordu.
- **`Retry-After` CORS'ta expose edilmiyordu.** CORS'un güvenli liste
  header'larından değil ve API başka bir origin'de, yani tarayıcı onu hiç
  görmüyordu. İstemcide "5 dakika sonra tekrar dene" yazacak kod baştan beri
  vardı ve hep belirsiz yedek mesajı gösteriyordu.
- **Bilinmeyen bir API yolu Express'in HTML hata sayfasını dönüyordu**, JSON
  değil — `apiErrorMessage()` gövdeden `{ message }` okuduğu için kullanıcı
  genel bir hata görüyordu.
- Altı form kontrolünün erişilebilir adı yoktu; dört dialog yalnızca görünüşte
  modaldı; dil düğmesi WCAG 2.5.3'ü ihlal ediyordu.

## Kendi testlerimden dördü yanlıştı

Her biri **hiçbir şey kanıtlamadan geçiyordu**, ki bu kırmızı olmaktan kötüdür.
Örneği: "her route render ediliyor" testi, tamamen çökmüş bir `/analytics`'e
karşı geçiyordu — çünkü `AppErrorBoundary`'nin çökme ekranı da `<main>` içinde
render oluyor. Artık her route testi çökme ekranının **yok** olduğunu da
doğruluyor. Diğer üçü README'nin İngilizce bölümünde ve kodun içinde,
olduğu yerde anlatılıyor.

## Bilinen kısıtlar

- **`APP_MODE=dev` tek worker'lık geliştirme döngüsü için**, paralel koşu için
  değil: birden fazla worker altında Vite dev server lazy chunk'ı ara sıra
  servis edemiyor ve uygulamanın error boundary'si bunu yakalıyor — tam olarak
  bir ürün çökmesi gibi görünüyor. Varsayılan (`build`) modda bu sorun yok.
- **Görsel baseline'lar CI'da, Linux'ta üretiliyor**, başka hiçbir yerde: font
  rasterleştirmesi platform başına farklı, Windows'ta çekilen baseline runner'da
  her glif'in her pikselinde kırmızı yanar.
- **CI uygulama repolarını SSH ile okuyor**: repo başına salt-okunur birer
  deploy key (`WEB_REPO_DEPLOY_KEY`, `API_REPO_DEPLOY_KEY`). PAT de olurdu ama
  o, hesabın görebildiği her şeye read erişimi olan tek bir kimlik bilgisi
  olurdu — elle üretilip elle yenilenmesi gerekirdi. Deploy key tek bir repoya
  kapsamlı, salt-okunur, süresi dolmuyor ve tamamen komut satırından
  kurulabiliyor.
