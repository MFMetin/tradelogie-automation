import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/config/env';

/**
 * Writes the CSV files the import tests feed the wizard.
 *
 * Generated rather than hand-written, for two reasons. The 601-row file exists
 * only to cross the wizard's 500-row chunk boundary and would be absurd to
 * commit by hand; and the MT5 header row has to match the preset's signature
 * EXACTLY — `['position', 'symbol', 'volume', 'profit']` after normalisation —
 * so having one place that knows the column names keeps a typo from turning
 * "the preset was detected" into a test about the fallback path instead.
 *
 *     npm run fixtures:csv
 */
const OUT = path.join(REPO_ROOT, 'fixtures-data');

/**
 * MetaTrader 5 / Exness "History" export.
 *
 * Column names, date format and sign conventions are all from the real thing:
 * the dates are `yyyy.MM.dd HH:mm:ss` on the broker's own UTC+3 clock, and
 * commission is a NEGATIVE debit — the importer takes its absolute value,
 * which is why a fee of -1.20 has to end up stored as 1.20.
 */
const MT5_HEADERS = [
  'Position',
  'Symbol',
  'Type',
  'Volume',
  'Price',
  'S / L',
  'T / P',
  'Time',
  'Price (2)',
  'Time (2)',
  'Commission',
  'Swap',
  'Profit',
];

interface Mt5Row {
  position: number;
  symbol: string;
  type: 'buy' | 'sell';
  volume: string;
  entry: string;
  sl: string;
  tp: string;
  openedAt: string;
  exit: string;
  closedAt: string;
  commission: string;
  profit: string;
}

function mt5Line(row: Mt5Row): string {
  return [
    row.position,
    row.symbol,
    row.type,
    row.volume,
    row.entry,
    row.sl,
    row.tp,
    row.openedAt,
    row.exit,
    row.closedAt,
    row.commission,
    '0.00',
    row.profit,
  ].join(',');
}

function mt5File(rows: Mt5Row[]): string {
  return [MT5_HEADERS.join(','), ...rows.map(mt5Line)].join('\n') + '\n';
}

const SYMBOLS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USTEC', 'BTCUSD'];

function mt5Rows(count: number, startPosition = 100_001): Mt5Row[] {
  return Array.from({ length: count }, (_, index) => {
    const day = (index % 28) + 1;
    const month = (Math.floor(index / 28) % 12) + 1;
    const stamp = (hour: number) =>
      `2026.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')} ` +
      `${String(hour).padStart(2, '0')}:15:00`;
    const long = index % 2 === 0;
    const entry = 1900 + index;

    return {
      position: startPosition + index,
      symbol: SYMBOLS[index % SYMBOLS.length]!,
      type: long ? 'buy' : 'sell',
      volume: '0.10',
      entry: entry.toFixed(2),
      sl: (entry - 10).toFixed(2),
      tp: (entry + 20).toFixed(2),
      openedAt: stamp(9),
      exit: (entry + (long ? 12 : -8)).toFixed(2),
      closedAt: stamp(15),
      // Negative, as the broker exports it.
      commission: '-1.20',
      profit: (long ? 12 : 8).toFixed(2),
    };
  });
}

/** Headers no preset recognises, so `columnGuess` has to carry the file. */
function unknownBrokerFile(): string {
  const headers = [
    'Instrument',
    'Direction',
    'Qty',
    'Open Rate',
    'Close Rate',
    'Opened (UTC)',
    'Closed (UTC)',
    'Realised',
    'Charges',
  ];
  const rows = [
    ['AAPL', 'LONG', '10', '180.50', '184.10', '2026-04-01 13:30:00', '2026-04-01 19:55:00', '36.00', '0.70'],
    ['MSFT', 'SHORT', '5', '410.00', '404.25', '2026-04-02 14:00:00', '2026-04-02 20:10:00', '28.75', '0.70'],
    ['NVDA', 'LONG', '2', '905.00', '889.00', '2026-04-03 13:45:00', '2026-04-03 18:20:00', '-32.00', '0.70'],
  ];
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

/**
 * Recognised as MT5, but with rows the server has to reject one at a time:
 * a blank symbol, a price that is not a number, and a missing open time.
 * `/trades/bulk` reports each by index instead of failing the batch.
 */
function malformedFile(): string {
  const good = mt5Rows(2, 300_001);
  const lines = [MT5_HEADERS.join(','), mt5Line(good[0]!)];

  lines.push(mt5Line({ ...good[0]!, position: 300_010, symbol: '' }));
  lines.push(mt5Line({ ...good[0]!, position: 300_011, entry: 'not-a-price' }));
  lines.push(mt5Line({ ...good[0]!, position: 300_012, openedAt: '' }));
  lines.push(mt5Line(good[1]!));

  return lines.join('\n') + '\n';
}

const FILES: Record<string, string> = {
  // The happy path: a preset-detected file small enough to eyeball.
  'mt5-20-trades.csv': mt5File(mt5Rows(20)),
  // 601 rows: two chunks at the wizard's 500-row boundary, and nothing more.
  'mt5-601-trades.csv': mt5File(mt5Rows(601, 200_001)),
  // Three bad rows among three good ones.
  'mt5-malformed.csv': malformedFile(),
  // The case the wizard actually exists for.
  'unknown-broker.csv': unknownBrokerFile(),
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, contents] of Object.entries(FILES)) {
  fs.writeFileSync(path.join(OUT, name), contents);
  const rows = contents.trimEnd().split('\n').length - 1;
  console.log(`${name.padEnd(24)} ${rows} rows`);
}
