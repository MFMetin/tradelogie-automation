import type { Locator, Page } from '@playwright/test';
import { t } from '../utils/i18n';
import { escapeRegExp } from '../utils/regex';

export interface TradeFormValues {
  symbol?: string;
  side?: 'buy' | 'sell';
  status?: 'open' | 'closed';
  entryPrice?: string;
  exitPrice?: string;
  size?: string;
  pnl?: string;
  fee?: string;
  notes?: string;
  openedAt?: string;
  closedAt?: string;
}

/**
 * The add/edit trade dialog.
 *
 * Every field is reachable by label because `TradeForm`'s own `Field` component
 * WRAPS its control in a `<label>`, which associates them implicitly. The one
 * wrinkle is that a required field's accessible name includes the asterisk the
 * component renders, so matching is non-exact throughout.
 *
 * Everything is scoped to the dialog. Two reasons, both real here: the journal's
 * trigger button and this dialog's heading are the same string in both
 * languages (`dash.logTrade` and `tf.logTitle`), and `Modal` renders a
 * full-bleed backdrop `<button>` that a page-wide button query can hit.
 */
export class TradeFormModal {
  constructor(private readonly page: Page) {}

  /** Named by its own heading, which is what `aria-labelledby` now provides. */
  get root(): Locator {
    return this.page.getByRole('dialog', {
      name: new RegExp(`${escapeRegExp(t('tf.logTitle'))}|${escapeRegExp(t('tf.editTitle'))}`),
    });
  }

  get symbol(): Locator {
    return this.root.getByLabel(t('tf.symbol'));
  }

  get entryPrice(): Locator {
    return this.root.getByLabel(t('tf.entryPrice'));
  }

  get exitPrice(): Locator {
    return this.root.getByLabel(t('tf.exitPrice'));
  }

  get size(): Locator {
    return this.root.getByLabel(t('tf.sizeQty'));
  }

  get realizedPnl(): Locator {
    return this.root.getByLabel(t('tf.realizedPnl'));
  }

  get fee(): Locator {
    return this.root.getByLabel(t('tf.fee'));
  }

  get notes(): Locator {
    return this.root.getByLabel(t('tf.notes'));
  }

  get openedAt(): Locator {
    return this.root.getByLabel(t('tf.openedAt'));
  }

  get closedAt(): Locator {
    return this.root.getByLabel(t('tf.closedAt'));
  }

  /**
   * The side and status toggles are pairs of buttons, not selects, and which
   * one is chosen used to be expressed only as a colour — so there was nothing
   * to assert on and nothing for a screen reader to read. They carry
   * `aria-pressed` now, which is both the fix and the handle.
   *
   * The `data-testid` is here because the two sides' labels are
   * `tf.longBuy`/`tf.shortSell` ("Long / Buy", "Short / Sell") while the state
   * they set is `buy`/`sell`; keying the page object on the label would make
   * `sideButton('buy')` read as a translation lookup rather than a state.
   */
  sideButton(side: 'buy' | 'sell'): Locator {
    return this.root.getByTestId(`trade-side-${side}`);
  }

  statusButton(status: 'open' | 'closed'): Locator {
    return this.root.getByTestId(`trade-status-${status}`);
  }

  get submit(): Locator {
    return this.root.getByRole('button', {
      name: new RegExp(`${escapeRegExp(t('tf.addTrade'))}|${escapeRegExp(t('tf.saveChanges'))}`),
    });
  }

  get cancel(): Locator {
    return this.root.getByRole('button', { name: t('common.cancel') });
  }

  get closeButton(): Locator {
    return this.root.getByTestId('modal-close');
  }

  async fill(values: TradeFormValues): Promise<void> {
    // Status first: setting it to `open` disables the exit price and close
    // time, so filling them beforehand would be silently discarded.
    if (values.status) await this.statusButton(values.status).click();
    if (values.side) await this.sideButton(values.side).click();

    if (values.symbol !== undefined) await this.symbol.fill(values.symbol);
    if (values.entryPrice !== undefined) await this.entryPrice.fill(values.entryPrice);
    if (values.exitPrice !== undefined) await this.exitPrice.fill(values.exitPrice);
    if (values.size !== undefined) await this.size.fill(values.size);
    if (values.pnl !== undefined) await this.realizedPnl.fill(values.pnl);
    if (values.fee !== undefined) await this.fee.fill(values.fee);
    if (values.notes !== undefined) await this.notes.fill(values.notes);
    if (values.openedAt !== undefined) await this.openedAt.fill(values.openedAt);
    if (values.closedAt !== undefined) await this.closedAt.fill(values.closedAt);
  }

  async submitAndClose(): Promise<void> {
    await this.submit.click();
    await this.root.waitFor({ state: 'hidden' });
  }

  async save(values: TradeFormValues): Promise<void> {
    await this.fill(values);
    await this.submitAndClose();
  }
}

