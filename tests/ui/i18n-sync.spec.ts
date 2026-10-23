import fs from 'node:fs';
import { test, expect } from '../../src/fixtures/base';
import { STRINGS } from '../../src/utils/strings';
import { generate, OUTPUT, KEYS } from '../../scripts/sync-i18n';

/**
 * Keeps the generated copy honest.
 *
 * `src/utils/strings.ts` is a committed snapshot of the app's own dictionaries,
 * because this repository has to run with nothing but its own files. A snapshot
 * drifts, and the way it drifts is the expensive kind: a renamed string makes
 * eight unrelated tests fail with "element not found", and whoever reads that
 * output goes hunting for a missing button.
 *
 * Regenerating and comparing turns all of that into one failure, in one place,
 * that says exactly what moved and how to fix it.
 *
 * This is also the only test in the suite that reads the application's source
 * rather than its behaviour, which is why it says so loudly.
 */
test.describe('the generated strings', () => {
  test('still match the app dictionaries', () => {
    const committed = fs.readFileSync(OUTPUT, 'utf8');
    const regenerated = generate();

    expect(
      regenerated,
      'src/utils/strings.ts is out of date with the app’s src/i18n/{en,tr}.ts.\n' +
        'Run `npm run sync:i18n` and commit the result.\n' +
        'If a string was renamed or removed, update the KEYS list in ' +
        'scripts/sync-i18n.ts to match.',
    ).toBe(committed);
  });

  test('cover every key the suite selects by', () => {
    const committed = fs.readFileSync(OUTPUT, 'utf8');
    for (const key of KEYS) {
      expect(committed, `'${key}' is missing from the generated file`).toContain(`'${key}':`);
    }
  });

  test('carry both languages for every key', () => {
    for (const [key, value] of Object.entries(STRINGS)) {
      expect(value.en, `${key} has no English`).toBeTruthy();
      expect(value.tr, `${key} has no Turkish`).toBeTruthy();
      // A key whose two languages are identical is usually an untranslated
      // string rather than a coincidence — worth knowing, not worth failing
      // over, since product names and codes legitimately match.
      if (value.en === value.tr) {
        console.log(`[i18n] '${key}' is the same in both languages: "${value.en}"`);
      }
    }
  });
});
