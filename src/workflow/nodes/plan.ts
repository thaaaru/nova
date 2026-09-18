import type { GraphState } from "../state.js";
import { generatePlanFromDiscovery } from "../plan-templates.js";

/**
 * Node 2: plan. Converts the engineer's objective plus whatever discover
 * found into a structured TestPlan via deterministic templates — no LLM
 * in this path for the MVP. planId is set equal to runId: this MVP holds
 * exactly one plan per run, so the two identifier spaces are deliberately
 * unified rather than adding a second lookup index for no behavioral gain.
 */
export function createPlanNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    if (!run.objective) {
      throw new Error("plan node requires run.objective to be set before it runs.");
    }
    if (!run.discoverySnapshot) {
      throw new Error("plan node requires a discovery snapshot before it runs.");
    }

    const plan = generatePlanFromDiscovery(
      run.runId,
      run.targetManifest,
      run.discoverySnapshot,
      run.objective,
    );

    return {
      run: {
        ...run,
        testPlan: plan,
        status: "awaiting_approval",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "plan_ready_for_approval",
            detail: { planId: plan.id, caseCount: plan.cases.length },
            actor: "system",
          },
        ],
      },
    };
  };
}
