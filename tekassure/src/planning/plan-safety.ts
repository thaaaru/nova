import { randomUUID } from "node:crypto";

import type {
  AppSnapshot,
  DiscoveredControl,
  PageSnapshot,
  PlannedAction,
  TestPlan,
  TestPlanStep,
} from "../domain.js";
import { isDestructiveAction } from "./action-safety.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function findPage(snapshot: AppSnapshot, path: string): PageSnapshot | undefined {
  return snapshot.pages.find((page) => page.path === path);
}

function findMatchingControl(
  page: PageSnapshot,
  target: NonNullable<PlannedAction["target"]>,
): DiscoveredControl | undefined {
  return page.controls.find((control) => {
    if (control.kind !== target.kind) {
      return false;
    }
    if (target.label && control.label && normalize(control.label) === normalize(target.label)) {
      return true;
    }
    if (target.name && control.name && normalize(control.name) === normalize(target.name)) {
      return true;
    }
    return false;
  });
}

/**
 * The single enforcement point for every "interact" action regardless of
 * which planner produced it (heuristic never emits one; this is the real
 * gate for an LLM-generated plan). An action is dropped — never merely
 * flagged — if any of the following hold, with the reason recorded in
 * plan.warnings so the reviewer sees exactly what was removed and why:
 *
 * - interactions are disabled for this run (allowInteractions is false)
 * - it matches a destructive-verb denylist (delete, pay, checkout, ...)
 * - its target doesn't resolve to a real control the discoverer found —
 *   this is the hallucination guard: an LLM can describe a plausible
 *   button that doesn't exist, and it must never be attempted blind.
 *
 * A step left with zero actions after filtering is dropped entirely.
 */
export function enforcePlanSafety(
  plan: TestPlan,
  snapshot: AppSnapshot,
  allowInteractions: boolean,
): TestPlan {
  const warnings: string[] = [...plan.warnings];
  const steps: TestPlanStep[] = [];

  for (const step of plan.steps) {
    const actions: PlannedAction[] = [];
    for (const action of step.actions) {
      if (action.kind !== "interact") {
        actions.push(action);
        continue;
      }

      if (!allowInteractions) {
        warnings.push(`Dropped interaction "${action.description}": interactions are disabled for this run.`);
        continue;
      }

      if (isDestructiveAction(action)) {
        warnings.push(
          `Dropped interaction "${action.description}": it matches a disallowed destructive pattern.`,
        );
        continue;
      }

      const page = action.target ? findPage(snapshot, action.target.page) : undefined;
      const control = page && action.target ? findMatchingControl(page, action.target) : undefined;
      if (!action.target || !page || !control) {
        warnings.push(
          `Dropped interaction "${action.description}": no matching control was found in the discovered app.`,
        );
        continue;
      }

      actions.push(action);
    }

    if (actions.length > 0) {
      steps.push({ ...step, actions });
    } else if (step.actions.length > 0) {
      warnings.push(`Dropped step "${step.title}": every action in it was removed.`);
    }
  }

  // TestPlanSchema requires at least one step; a plan that generated only
  // interact steps, all of which then failed safety filtering, would
  // otherwise be empty. A single guaranteed-safe baseline check keeps the
  // plan valid and still gives the reviewer something real to approve.
  if (steps.length === 0) {
    warnings.push(
      "Every planned step was removed by safety filtering; falling back to a baseline page load.",
    );
    steps.push({
      id: randomUUID(),
      title: "Baseline page load",
      rationale: "No other step survived safety filtering.",
      risk: "read_only",
      requiresApproval: false,
      actions: [{ kind: "inspect", description: "Load the target's homepage and confirm it renders." }],
      expectedResult: "The homepage loads successfully with no console or page errors.",
    });
  }

  return { ...plan, steps, warnings };
}
