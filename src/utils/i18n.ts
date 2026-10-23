import { env } from '../config/env';
import { STRINGS, type StringKey } from './strings';

/**
 * The exact string the app renders, in the language the suite pinned.
 *
 * Every text-based selector and every message assertion goes through here.
 * Three reasons it is not a literal in the test:
 *
 *   - The app defaults to Turkish and never reads `navigator.language`, so a
 *     hand-typed English string passes nowhere.
 *   - The Turkish dictionary uses the typographic apostrophe (`CSV’den`), which
 *     is almost impossible to notice in a failing diff.
 *   - Running the same test in both languages is then a config change rather
 *     than a second copy of the test.
 *
 * `src/utils/strings.ts` is generated from the app's own dictionaries by
 * `npm run sync:i18n`, and `tests/ui/i18n-sync.spec.ts` fails if it has drifted.
 */
export function t(key: StringKey): string {
  return STRINGS[key][env.lang];
}

/** The same string in a named language, for the tests that compare the two. */
export function tIn(key: StringKey, lang: 'tr' | 'en'): string {
  return STRINGS[key][lang];
}

/**
 * An interpolating string as a pattern.
 *
 * `csv.importBtn` is `Import {count} trades` / `{count} işlemi aktar`, so no
 * literal matches it and a `toHaveText` would need the count baked in. This
 * turns the template into a regex: placeholders become `.+` and everything
 * else is escaped, so `pattern('csv.importBtn')` matches whatever number the
 * page put there.
 */
export function pattern(key: StringKey, lang: 'tr' | 'en' = env.lang): RegExp {
  const template = STRINGS[key][lang];
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/\\\{[a-zA-Z]+\\\}/g, '.+'));
}

/** Fills an interpolating string, for asserting on an exact rendered message. */
export function format(
  key: StringKey,
  values: Record<string, string | number>,
  lang: 'tr' | 'en' = env.lang,
): string {
  return STRINGS[key][lang].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

export type { StringKey };
