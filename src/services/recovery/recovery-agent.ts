import type { Page } from "playwright";

import type { RecoveryAttempt, TestStep } from "../../domain/index.js";

/**
 * Deterministic, bounded recovery: when a step's declared locator strategy
 * fails to find exactly one element, try a fixed, ordered set of alternate
 * *semantic* ways to find the same declared target on the same page —
 * never a different page, domain, or action. This is not an LLM decision;
 * the strategy order is fixed code, so it inherits none of the "the model
 * could reinterpret scope" risk. It never retries navigation, never
 * resolves secrets, and never changes what the step asserts.
 *
 * Recovery is exhausted after `budget` tries (a TestCase's own
 * recoveryBudget, already policy-reviewed as part of plan approval); once
 * exhausted the original failure is reported unchanged.
 */
export async function attemptStepRecovery(options: {
  page: Page;
  step: TestStep;
  stepIndex: number;
  failureSummary: string;
  budget: number;
}): Promise<{
  recovered: boolean;
  usedLocator?: ReturnType<Page["locator"]>;
  /**
   * A concrete, re-usable selector string equivalent to whichever
   * strategy actually recovered the step — e.g. `role=button[name="Add
   * to cart"]` or `text=Add to cart`. Present only when `recovered` is
   * true. This is what selector-healing.ts persists back onto the
   * originating ApplicationTestMap checkpoint step, so the *next* run
   * finds the element on the first try instead of needing runtime
   * recovery again.
   */
  healedSelector?: string;
  attempts: RecoveryAttempt[];
}> {
  const { page, step, stepIndex, failureSummary, budget } = options;
  const attempts: RecoveryAttempt[] = [];

  if (budget <= 0) {
    return { recovered: false, attempts };
  }

  const strategies = buildFallbackStrategies(step);
  const bounded = strategies.slice(0, budget);

  for (const [index, strategy] of bounded.entries()) {
    const attemptNumber = index + 1;
    try {
      const locator = strategy.locate(page);
      const count = await locator.count();
      if (count === 1) {
        const healedSelector = strategy.toSelector();
        attempts.push({
          stepIndex,
          checkpoint: describeCheckpoint(step),
          failureSummary,
          evidenceSummary: `Declared locator did not resolve; DOM still contains a single matching element via ${strategy.label}.`,
          action: `Re-derive target using ${strategy.label}.`,
          attempt: attemptNumber,
          maxAttempts: bounded.length,
          outcome: "recovered",
          healedSelector,
        });
        return { recovered: true, usedLocator: locator, healedSelector, attempts };
      }
      attempts.push({
        stepIndex,
        checkpoint: describeCheckpoint(step),
        failureSummary,
        evidenceSummary:
          count === 0
            ? `No element matched via ${strategy.label}.`
            : `${count} elements matched via ${strategy.label}; ambiguous, not used.`,
        action: `Tried ${strategy.label}.`,
        attempt: attemptNumber,
        maxAttempts: bounded.length,
        outcome: attemptNumber === bounded.length ? "exhausted" : "recovered",
      });
    } catch (error) {
      attempts.push({
        stepIndex,
        checkpoint: describeCheckpoint(step),
        failureSummary,
        evidenceSummary: error instanceof Error ? error.message : String(error),
        action: `Tried ${strategy.label}.`,
        attempt: attemptNumber,
        maxAttempts: bounded.length,
        outcome: "exhausted",
      });
    }
  }

  if (attempts.length > 0) {
    attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], outcome: "exhausted" };
  }
  return { recovered: false, attempts };
}

function describeCheckpoint(step: TestStep): string {
  return step.name ?? step.selector ?? step.role ?? step.kind;
}

/** Escapes a name for embedding inside a Playwright `role=`/CSS-attribute selector-engine string. */
function escapeForSelectorString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function buildFallbackStrategies(
  step: TestStep,
): Array<{ label: string; locate: (page: Page) => ReturnType<Page["locator"]>; toSelector: () => string }> {
  const strategies: Array<{
    label: string;
    locate: (page: Page) => ReturnType<Page["locator"]>;
    toSelector: () => string;
  }> = [];
  const name = step.name;

  if (name) {
    const escapedName = escapeForSelectorString(name);
    if (step.role) {
      // Original was role+name but ambiguous/failed name casing — try a looser role match.
      strategies.push({
        label: `role "${step.role}" with loose name match`,
        locate: (page) =>
          page.getByRole(step.role as Parameters<Page["getByRole"]>[0], { name, exact: false }),
        toSelector: () => `role=${step.role}[name="${escapedName}" i]`,
      });
    } else {
      // Two separate, ordered role checks instead of one combined
      // `.or(...)` locator — each one maps to a concrete, re-usable
      // `role=` selector string when it is the strategy that recovers.
      strategies.push({
        label: "button role with exact name",
        locate: (page) => page.getByRole("button", { name }),
        toSelector: () => `role=button[name="${escapedName}"]`,
      });
      strategies.push({
        label: "link role with exact name",
        locate: (page) => page.getByRole("link", { name }),
        toSelector: () => `role=link[name="${escapedName}"]`,
      });
    }
    strategies.push({
      label: "visible text (loose match)",
      locate: (page) => page.getByText(name, { exact: false }),
      toSelector: () => `text=${name}`,
    });
    strategies.push({
      label: "accessible label",
      locate: (page) => page.getByLabel(name, { exact: false }),
      toSelector: () => `[aria-label="${escapedName}"]`,
    });
  }

  if (step.selector) {
    strategies.push({
      label: "declared selector",
      locate: (page) => page.locator(step.selector as string),
      toSelector: () => step.selector as string,
    });
  }

  return strategies;
}
