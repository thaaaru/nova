import type { GraphState } from "../state.js";
import type { PlanGenerator } from "../../services/llm/openai-plan-generator.js";
import { checkCaseScope } from "../../services/policy/scope-policy.js";
import { generatePlanFromDiscovery } from "../plan-templates.js";

export type PlanDependencies = {
  /**
   * Optional — omitted whenever no OPENAI_API_KEY is configured (see
   * config/index.ts and cli/context.ts). When present, the LLM proposes
   * cases; when absent, the node falls straight to the deterministic
   * template path, exactly as it always has.
   */
  generateCases?: PlanGenerator;
};

/**
 * Node 2: plan. Converts the engineer's objective plus whatever discover
 * found into a structured TestPlan.
 *
 * When an LLM plan generator is configured, the model proposes cases from
 * the objective + discovery snapshot, but it never gets the final word:
 * every proposed case is re-checked against checkCaseScope (the same
 * authoritative, code-only scope check every other case in this product
 * goes through) before it can reach approval. Any case that fails, or an
 * LLM call that throws or returns nothing usable, falls back to the
 * deterministic template planner — the plan is never empty and never
 * trusts model output for authorization, only for proposing plan content
 * a human still has to approve before anything runs.
 *
 * planId is set equal to runId: this MVP holds exactly one plan per run,
 * so the two identifier spaces are deliberately unified rather than
 * adding a second lookup index for no behavioral gain.
 */
export function createPlanNode(deps: PlanDependencies = {}) {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const run = state.run;
    if (!run.objective) {
      throw new Error("plan node requires run.objective to be set before it runs.");
    }
    if (!run.discoverySnapshot) {
      throw new Error("plan node requires a discovery snapshot before it runs.");
    }

    const templatePlan = generatePlanFromDiscovery(
      run.runId,
      run.targetManifest,
      run.discoverySnapshot,
      run.objective,
    );

    let plan = templatePlan;
    let authoredBy: "llm" | "template" = "template";
    let rejectedCaseCount = 0;

    if (deps.generateCases) {
      try {
        const proposed = await deps.generateCases({
          objective: run.objective,
          manifest: run.targetManifest,
          snapshot: run.discoverySnapshot,
        });
        const inScope = proposed.filter((testCase) => {
          const result = checkCaseScope(testCase, run.targetManifest);
          if (!result.ok) {
            rejectedCaseCount += 1;
          }
          return result.ok;
        });
        if (inScope.length > 0) {
          plan = { ...templatePlan, cases: inScope };
          authoredBy = "llm";
        }
      } catch {
        // LLM call failed (network, rate limit, malformed output that
        // couldn't even be structurally parsed) — the template plan
        // computed above already stands in, so execution never blocks on
        // a third-party API being available.
      }
    }

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
            detail: { planId: plan.id, caseCount: plan.cases.length, authoredBy, rejectedCaseCount },
            actor: "system",
          },
        ],
      },
    };
  };
}
