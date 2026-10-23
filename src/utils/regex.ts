/**
 * Escapes a string for use inside a regular expression.
 *
 * Needed all over the page objects: Playwright matches an accessible name
 * either exactly or by regex, and several controls here legitimately have two
 * possible names — "Add trade" or "Save changes" on the trade form's submit,
 * "Switch to light" or "Switch to dark" on the theme toggle. Building that
 * alternation means putting translated copy into a pattern, and the copy
 * contains regex metacharacters: `Realized P&L`, `Size / Qty`, and every
 * sentence that ends in a full stop.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `a|b` as a pattern, for a control whose name depends on its state. */
export function eitherName(...names: string[]): RegExp {
  return new RegExp(names.map(escapeRegExp).join('|'));
}
