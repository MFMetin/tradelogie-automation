import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { REPO_ROOT } from '../config/env';
import { t, pattern, format } from '../utils/i18n';

export const FIXTURES = path.join(REPO_ROOT, 'fixtures-data');

/**
 * The CSV import wizard: file → columns → preview → result.
 *
 * Two things about this component shape the page object.
 *
 * The file input is `class="hidden"` and driven by a button click, but it IS in
 * the DOM — so `setInputFiles` works on it directly and the button never has to
 * be touched. The drop zone next to it is a plain `<div>` with drag handlers and
 * no role, so the drag path is not automatable at all; that is a real gap in the
 * component rather than in the test, and it is noted here instead of faked.
 *
 * The mapping step renders BOTH layouts at once — a table at `sm` and up, a
 * stack below — bound to the same state. A bare `select` query therefore matches
 * every field twice. Each one carries a layout-specific `data-testid`, which is
 * the honest case for a test id: the two controls are genuinely
 * indistinguishable by role, name or position.
 */
export class ImportWizard {
  constructor(private readonly page: Page) {}

  get root(): Locator {
    return this.page.getByRole('dialog', { name: t('csv.title') });
  }

  /** The real input, hidden behind the "Choose a file" button. */
  get fileInput(): Locator {
    return this.root.locator('input[type="file"]');
  }

  get nextButton(): Locator {
    return this.root.getByRole('button', { name: t('csv.next') });
  }

  get backButton(): Locator {
    return this.root.getByRole('button', { name: t('csv.back') });
  }

  /** `Import {count} trades` — interpolated, so a literal never matches. */
  get importButton(): Locator {
    return this.root.getByRole('button', { name: pattern('csv.importBtn') });
  }

  /** The mapping select for one target field, in whichever layout is on screen. */
  columnSelect(field: string): Locator {
    const table = this.root.getByTestId(`csv-map-${field}`);
    const stacked = this.root.getByTestId(`csv-map-sm-${field}`);
    // `or` resolves to whichever is visible; both are in the DOM, only one is
    // painted, and Playwright's visibility check is what picks.
    return table.or(stacked).filter({ visible: true });
  }

  get dateFormatSelect(): Locator {
    return this.root.getByLabel(t('csv.dateFormat'));
  }

  get saveMappingCheckbox(): Locator {
    return this.root.getByRole('checkbox', { name: t('csv.saveMapping') });
  }

  get mappingNameInput(): Locator {
    return this.root.getByLabel(t('csv.mappingName'));
  }

  /** The "detected <broker>" badge the preset step shows. */
  detectedBadge(broker: string): Locator {
    return this.root.getByText(new RegExp(broker, 'i'));
  }

  async open(): Promise<void> {
    await this.root.waitFor({ state: 'visible' });
  }

  async choose(fixture: string): Promise<void> {
    await this.fileInput.setInputFiles(path.join(FIXTURES, fixture));
    // The file is parsed in the browser — it never reaches the server — so the
    // step advances on its own once papaparse is done.
    await this.nextButton.waitFor({ state: 'visible' });
  }

  async toPreview(): Promise<void> {
    await this.nextButton.click();
    await this.importButton.waitFor({ state: 'visible' });
  }

  async runImport(): Promise<void> {
    await this.importButton.click();
  }

  /**
   * The result step's own lines.
   *
   * Precise on purpose. Asserting `toContainText('3')` against the whole dialog
   * passed at the COLUMNS step, because the stepper renders "3 Preview" on every
   * screen — so a test for "3 rows imported" went green before the import had
   * started, and then looked for rows that were not there yet. The numbers in a
   * wizard are the last thing to match loosely.
   */
  get resultTitle(): Locator {
    return this.root.getByText(t('csv.resultTitle'));
  }

  imported(count: number): Locator {
    return this.root.getByText(format('csv.resultImported', { count }));
  }

  skipped(count: number): Locator {
    return this.root.getByText(format('csv.resultSkipped', { count }));
  }

  rejected(count: number): Locator {
    return this.root.getByText(format('csv.resultFailed', { count }));
  }

  /** Waits for the import to finish, then asserts how much landed. */
  async expectImported(count: number, timeout = 60_000): Promise<void> {
    await this.resultTitle.waitFor({ state: 'visible', timeout });
    await this.imported(count).waitFor({ state: 'visible', timeout: 10_000 });
  }

}
