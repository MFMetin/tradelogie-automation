import fs from 'node:fs';
import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { REPO_ROOT } from '../config/env';

export const BASELINE_FILE = path.join(REPO_ROOT, 'a11y-baseline.json');

export interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
  targets: string[];
}

/**
 * One accepted violation: a rule, on a screen, with how many nodes broke it.
 *
 * The COUNT is the important part. An allowlist of rule ids alone would accept
 * a seventh unlabelled input on a page that already had six, which is how an
 * accessibility baseline quietly becomes a licence.
 */
export interface BaselineEntry {
  screen: string;
  rule: string;
  nodes: number;
  note?: string;
}

function readBaseline(): BaselineEntry[] {
  if (!fs.existsSync(BASELINE_FILE)) return [];
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as BaselineEntry[];
}

/**
 * Scans the current page and fails on anything not in the baseline.
 *
 * Why a baseline at all: a real application that has never been audited has
 * existing violations, and a suite that goes red on all of them on day one gets
 * switched off within a week. Recording what is already broken makes the gate
 * meaningful — a NEW violation, or MORE nodes under an existing rule, fails —
 * while every line of `a11y-baseline.json` stays a visible, countable to-do.
 *
 * Six entries came off that list while this suite was being written, because
 * the right response to "this control has no accessible name" is to give it one
 * in the app, not to write a cleverer selector.
 */
export async function expectNoNewViolations(page: Page, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    // The levels that describe a barrier rather than a preference. `best-practice`
    // is deliberately out: it flags things like heading order, which are worth
    // fixing but would bury the ones that stop someone using the page.
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const found: Violation[] = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? null,
    help: violation.help,
    nodes: violation.nodes.length,
    targets: violation.nodes.slice(0, 4).flatMap((node) => node.target.map(String)),
  }));

  const baseline = readBaseline().filter((entry) => entry.screen === screen);
  const unexpected: string[] = [];

  for (const violation of found) {
    const accepted = baseline.find((entry) => entry.rule === violation.id);

    if (!accepted) {
      unexpected.push(
        `NEW  ${violation.id} (${violation.impact}) × ${violation.nodes}` +
          `\n     ${violation.help}` +
          `\n     ${violation.targets.join('\n     ')}`,
      );
      continue;
    }

    if (violation.nodes > accepted.nodes) {
      unexpected.push(
        `WORSE ${violation.id}: ${violation.nodes} nodes, baseline allows ${accepted.nodes}` +
          `\n      ${violation.targets.join('\n      ')}`,
      );
    }
  }

  // Also report a rule that is FIXED but still in the baseline. Left alone, the
  // file grows into a list of things that were true once.
  const stale = baseline.filter(
    (entry) => !found.some((violation) => violation.id === entry.rule),
  );

  expect(
    unexpected,
    `accessibility violations on "${screen}" that the baseline does not cover:\n\n` +
      `${unexpected.join('\n\n')}\n\n` +
      'Fix the markup, or — if it is genuinely accepted — add it to ' +
      'a11y-baseline.json with a note saying why.',
  ).toEqual([]);

  if (stale.length > 0) {
    console.log(
      `[a11y] "${screen}" no longer violates ${stale
        .map((entry) => entry.rule)
        .join(', ')} — remove it from a11y-baseline.json`,
    );
  }
}

/** Prints what a screen currently violates, for filling the baseline in. */
export async function reportViolations(page: Page, screen: string): Promise<Violation[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const found = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? null,
    help: violation.help,
    nodes: violation.nodes.length,
    targets: violation.nodes.slice(0, 4).flatMap((node) => node.target.map(String)),
  }));

  for (const violation of found) {
    console.log(
      `${screen}\t${violation.id}\t${violation.nodes}\t${violation.impact}\t${violation.help}`,
    );
  }
  return found;
}
