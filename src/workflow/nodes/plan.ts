import type { TestPlan } from "../../domain/index.js";
import type { TestCaseSuggester } from "../../services/llm/suggest-test-cases.js";
import { checkCaseScope } from "../../services/policy/scope-policy.js";
import { suggestTestCases, toTestPlan } from "../../services/testmap/suggestion-service.js";
import { generatePlanFromDiscovery } from "../plan-templates.js";
import { sha256Of } from "../../services/hash.js";
import type { GraphState } from "../state.js";

/**
 * Plan generation, validation, revision, and the hand-off to the local
 * HTML approval review.
 *
 * `suggest_test_cases` runs the deterministic rule pack first, so a plan
 * always exists even with no model configured or reachable, then lets a
 * model propose extra candidates. Every candidate — rule-derived or
 * model-proposed — goes through the same deterministic validation
 * (scope, target, route existence, persona, fixture, policy, duplicate,
 * side-effect classification, evidence traceability, executability)
 * before it can be shown to a reviewer.
 *
 * planId is set equal to runId: this MVP holds exactly one plan per run,
 * so the two identifier spaces are deliberately unified rather than
 * adding a second lookup index for no behavioral gain.
 */

export type PlanDependencies = {
  /** Omitted whenever no model is configured — the rule pack alone then produces the plan. */
  suggester?: TestCaseSuggester;
  knownPersonaIds?: string[];
  knownFixtureIds?: string[];
  onProgress?: (message: string) => void;
};

export function createSuggestTestCasesNode(deps: PlanDependencies = {}) {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const run = state.run;
    if (!run.objective) {
      throw new Error("suggest_test_cases requires run.objective to be set before it runs.");
    }
    if (!run.discoverySnapshot) {
      throw new Error("suggest_test_cases requires a discovery snapshot before it runs.");
    }

    const suggestions = await suggestTestCases({
      planId: run.runId,
      objective: run.objective,
      manifest: run.targetManifest,
      snapshot: run.discoverySnapshot,
      evidence: run.evidencePackage,
      identification: run.identification?.identification,
      suggester: deps.suggester,
      knownPersonaIds: deps.knownPersonaIds,
      knownFixtureIds: deps.knownFixtureIds,
      onProgress: deps.onProgress,
    });

    const template = generatePlanFromDiscovery(
      run.runId,
      run.targetManifest,
      run.discoverySnapshot,
      run.objective,
    );
    const plan = toTestPlan(suggestions, template);

    return {
      run: {
        ...run,
        suggestions,
        testPlan: plan,
        status: "planning",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "test_cases_suggested",
            detail: {
              planId: plan.id,
              acceptedCount: suggestions.accepted.length,
              rejectedCount: suggestions.rejected.length,
              ruleCount: suggestions.accepted.filter((entry) => entry.source === "rule").length,
              llmCount: suggestions.accepted.filter((entry) => entry.source === "llm").length,
            },
            actor: "system",
          },
        ],
      },
    };
  };
}

/**
 * The last deterministic check before a human sees the plan, and the
 * point at which the plan becomes immutable in practice: `planHash` is
 * computed here and every approval and execution request is bound to it.
 * A case that fails scope at this point is dropped, not merely flagged.
 */
export function createValidateTestPlanNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    if (!run.testPlan) {
      throw new Error("validate_test_plan requires a test plan before it runs.");
    }

    const inScope = run.testPlan.cases.filter((testCase) => checkCaseScope(testCase, run.targetManifest).ok);
    const droppedCount = run.testPlan.cases.length - inScope.length;
    if (inScope.length === 0) {
      return {
        run: {
          ...run,
          status: "blocked",
          auditEvents: [
            ...run.auditEvents,
            {
              timestamp: new Date().toISOString(),
              type: "plan_validation_failed",
              detail: { reason: "every case declared a domain outside the approved manifest" },
              actor: "system",
            },
          ],
        },
      };
    }

    const plan: TestPlan = { ...run.testPlan, cases: inScope };
    const planHash = sha256Of(plan);
    const acceptedIds = new Set(inScope.map((testCase) => testCase.id));

    return {
      run: {
        ...run,
        testPlan: plan,
        planHash,
        suggestions: run.suggestions
          ? {
              ...run.suggestions,
              accepted: run.suggestions.accepted.filter((entry) => acceptedIds.has(entry.id)),
            }
          : undefined,
        status: "awaiting_approval",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "plan_validated",
            detail: { planId: plan.id, planHash, caseCount: inScope.length, droppedCount },
            actor: "system",
          },
        ],
      },
    };
  };
}

/**
 * Records that the local review page was opened for this plan. The HTTP
 * server itself lives in the presentation layer (services/approval) and
 * is started by the CLI/TUI — a graph node owning a listening socket
 * would make the workflow un-resumable and un-testable.
 */
export function createOpenApprovalReviewNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    if (!run.testPlan || !run.planHash) {
      throw new Error("open_approval_review requires a validated plan with a plan hash.");
    }
    return {
      run: {
        ...run,
        status: "awaiting_approval",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "approval_review_opened",
            detail: { planId: run.testPlan.id, planHash: run.planHash },
            actor: "system",
          },
        ],
      },
    };
  };
}

/**
 * The "changes requested" loop: clears the previous decision and the
 * previous plan hash so a stale approval can never be replayed against
 * the revised plan, then routes back to suggestion.
 */
export function createReviseTestPlanNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    return {
      run: {
        ...run,
        approval: undefined,
        approvedPlanSnapshot: undefined,
        executionRequest: undefined,
        planHash: undefined,
        revisionCount: (run.revisionCount ?? 0) + 1,
        status: "planning",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "plan_revision_requested",
            detail: { revision: (run.revisionCount ?? 0) + 1 },
            actor: "operator",
          },
        ],
      },
    };
  };
}
