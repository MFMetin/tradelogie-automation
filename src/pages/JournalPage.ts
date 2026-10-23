import type { Locator, Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { AppShell } from './AppShell';
import { TradeFormModal } from './TradeFormModal';
import { t } from '../utils/i18n';
import { escapeRegExp } from '../utils/regex';

/**
 * The journal.
 *
 * It renders as a table at `lg` and up and as a stack of cards below it — and
 * crucially it mounts ONE of them, not both behind `hidden`, because a second
 * hidden copy of an expanded trade would hold its own note draft and POST it
 * over the one you just wrote.
 *
 * So the same page object has to drive two different trees. Both carry
 * `data-testid="trade-row"` and the same action ids, which is exactly the case
 * test ids are for: a row among twenty identical ones, in whichever layout is
 * on screen. Everything else here is still role- or label-based.
 */
export class JournalPage extends BasePage {
  readonly path = '/journal';
  readonly shell: AppShell;
  readonly tradeForm: TradeFormModal;

  constructor(page: Page) {
    super(page);
    this.shell = new AppShell(page);
    this.tradeForm = new TradeFormModal(page);
  }

  get rows(): Locator {
    return this.page.getByTestId('trade-row');
  }

  /** The row showing a given symbol, in either layout. */
  row(symbol: string): Locator {
    return this.rows.filter({ hasText: symbol });
  }

  rowAction(symbol: string, action: 'details' | 'edit' | 'delete'): Locator {
    return this.row(symbol).getByTestId(`trade-${action}`);
  }

  /**
   * The toolbar's button. An empty journal renders a second one with the same
   * label inside its empty state, so this is explicitly the first — a bare
   * query is a strict-mode violation exactly when there are no trades, which
   * is the state most of these tests start in.
   */
  get addTradeButton(): Locator {
    return this.page.getByRole('button', { name: t('dash.logTrade') }).first();
  }

  /** The same action offered by the empty state, when there is one. */
  get emptyStateAddTradeButton(): Locator {
    return this.page.getByRole('button', { name: t('dash.logTrade') }).nth(1);
  }

  get importCsvButton(): Locator {
    return this.page.getByRole('button', { name: t('csv.import') });
  }

  get search(): Locator {
    return this.page.getByPlaceholder(t('jr.searchSymbol'));
  }

  /**
   * The disclosure that reveals the filter row below `lg`.
   *
   * It exists only on the narrow layout — desktop's `showFilters` is
   * `isDesktop || filtersOpen`, so desktop can never hide its own filters and
   * has no toggle to click.
   */
  get filtersToggle(): Locator {
    return this.page.getByRole('button', {
      name: new RegExp(`${escapeRegExp(t('jr.filters'))}|filtre|filters`, 'i'),
    });
  }

  /** A `title`, not an `aria-label` — which still serves as the accessible name. */
  get accountFilter(): Locator {
    return this.page.getByTitle(t('jr.filterByAccount'));
  }

  /**
   * Makes the filter row reachable in either layout.
   *
   * Every filter test needs this: on a phone the row is collapsed, so a test
   * that went straight for the account select found nothing and reported it as
   * a missing control rather than a closed disclosure.
   */
  async revealFilters(): Promise<void> {
    if (await this.accountFilter.isVisible()) return;
    await this.filtersToggle.first().click();
    await this.accountFilter.waitFor({ state: 'visible' });
  }

  get sortSelect(): Locator {
    return this.page.getByRole('combobox', { name: t('jr.sortLabel') });
  }

  rowCheckbox(symbol: string): Locator {
    return this.row(symbol).getByRole('checkbox', { name: t('jr.selectRow') });
  }

  get bulkDeleteButton(): Locator {
    return this.page.getByRole('button', { name: t('common.delete') }).first();
  }

  async openCreateForm(): Promise<TradeFormModal> {
    await this.addTradeButton.click();
    await this.tradeForm.root.waitFor({ state: 'visible' });
    return this.tradeForm;
  }

  async openEditForm(symbol: string): Promise<TradeFormModal> {
    // On desktop the row actions are `opacity-0` until the row is hovered.
    // Playwright clicks by box rather than by paint, so this works either way,
    // but hovering first is what a person does and keeps the trace readable.
    await this.row(symbol).hover();
    await this.rowAction(symbol, 'edit').click();
    await this.tradeForm.root.waitFor({ state: 'visible' });
    return this.tradeForm;
  }

  /**
   * Deletes a trade and confirms. The confirmation is a `Modal`, so it is
   * named by its heading and `common.delete` inside it is a different button
   * from the row action that opened it.
   */
  async deleteTrade(symbol: string): Promise<void> {
    await this.row(symbol).hover();
    await this.rowAction(symbol, 'delete').click();

    const confirm = this.page.getByRole('dialog');
    await confirm.waitFor({ state: 'visible' });
    await confirm.getByRole('button', { name: t('common.delete') }).click();
    await confirm.waitFor({ state: 'hidden' });
  }

  override async waitUntilReady(): Promise<void> {
    await super.waitUntilReady();
    // The toolbar is present whether or not there are any trades, so it is the
    // signal that the route rendered — an empty journal has no rows to wait for.
    await this.addTradeButton.waitFor({ state: 'visible' });
  }
}

