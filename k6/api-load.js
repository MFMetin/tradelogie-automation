import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Trend } from 'k6/metrics';

/**
 * A small load profile for the API's read paths.
 *
 * Deliberately modest. The interesting question for this application is not
 * "how many thousands of requests a second" — it is a single Railway container
 * in front of one Postgres — but whether the two endpoints a signed-in page
 * actually waits on stay inside a few hundred milliseconds while several people
 * use it at once. Those are `GET /users/me`, which every page load makes and
 * which also counts the streak day, and `GET /trades`, which the journal,
 * dashboard and analytics all read because there is no analytics endpoint.
 *
 * Run it with:
 *
 *     npm run k6
 *
 * which is a launcher that refuses to point this anywhere but localhost. See
 * the guard below and `scripts/run-k6.ts`.
 */

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:8081/api/v1';
const TOKEN = __ENV.K6_TOKEN;

/**
 * The guard, and the reason this file can live in a public repository.
 *
 * A load script is one environment variable away from being a denial-of-service
 * tool against your own paying users, and the mistake is easy: copy a command
 * out of a README, forget to change the host. So the host is checked here, at
 * the top, and the run aborts rather than warns.
 */
const host = new URL(BASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  fail(
    `Refusing to run: K6_BASE_URL points at "${host}". ` +
      'This script only ever runs against a local API.',
  );
}

const tradesLatency = new Trend('trades_duration', true);
const profileLatency = new Trend('profile_duration', true);

export const options = {
  stages: [
    // Ramp rather than a step, so the numbers show how it degrades rather than
    // only whether it survives.
    { duration: '15s', target: 3 },
    { duration: '30s', target: 10 },
    { duration: '15s', target: 0 },
  ],

  thresholds: {
    // A failed request is a failed run. There is nothing to tune here: these
    // are reads by an authenticated user and they must not 5xx.
    http_req_failed: ['rate<0.01'],

    // The budget the UI is built around: the journal shows a loader until
    // /trades answers, so half a second at the 95th percentile is the point
    // where the page stops feeling instant.
    'http_req_duration{expected_response:true}': ['p(95)<500'],
    trades_duration: ['p(95)<500', 'p(99)<1500'],
    profile_duration: ['p(95)<250'],
  },

  // The suite's own backend sets DISABLE_RATE_LIMIT; without it the global
  // ceiling of 120/min per IP is reached in the first few seconds and the run
  // measures the limiter rather than the application. `scripts/run-k6.ts` says
  // so when it starts.
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

const headers = () => ({
  'Content-Type': 'application/json',
  // The server resolves the streak day boundary from this; a load run without
  // it would exercise a slightly different code path from a real browser.
  'X-Timezone': 'Europe/Istanbul',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
});

export default function () {
  // What every page load does first, and the call the session depends on.
  const profile = http.get(`${BASE_URL}/users/me`, { headers: headers() });
  profileLatency.add(profile.timings.duration);
  check(profile, {
    'profile: 200': (response) => response.status === 200,
    'profile: has an id': (response) => {
      try {
        return typeof response.json('id') === 'string';
      } catch {
        return false;
      }
    },
  });

  // The journal's own read. One page, the way the client asks for it.
  const trades = http.get(`${BASE_URL}/trades?limit=100&offset=0`, { headers: headers() });
  tradesLatency.add(trades.timings.duration);
  check(trades, {
    'trades: 200': (response) => response.status === 200,
    'trades: is an array': (response) => {
      try {
        return Array.isArray(response.json());
      } catch {
        return false;
      }
    },
  });

  // Roughly a person reading a page before clicking again. Without it this
  // measures how fast k6 can loop, not how the API behaves under use.
  sleep(1);
}

export function handleSummary(data) {
  return {
    'k6/summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  };
}

/** A short human summary; the JSON file has everything. */
function textSummary(data) {
  const metric = (name, stat) => {
    const value = data.metrics[name]?.values?.[stat];
    return value === undefined ? 'n/a' : `${Math.round(value)}ms`;
  };

  const failed = data.metrics.http_req_failed?.values?.rate ?? 0;

  return [
    '',
    '  Tradelogie API load',
    '  -------------------',
    `  requests        ${data.metrics.http_reqs?.values?.count ?? 0}`,
    `  failed          ${(failed * 100).toFixed(2)}%`,
    `  /users/me  p95  ${metric('profile_duration', 'p(95)')}`,
    `  /trades    p95  ${metric('trades_duration', 'p(95)')}`,
    `  /trades    p99  ${metric('trades_duration', 'p(99)')}`,
    '',
    '  Full detail in k6/summary.json.',
    '',
  ].join('\n');
}
