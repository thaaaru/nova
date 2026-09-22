import { END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import type { DiscoverDependencies } from "./nodes/discover.js";
import { createDiscoverNode } from "./nodes/discover.js";
import type { ContextDependencies } from "./nodes/context.js";
import {
  createEnsureAuthenticationNode,
  createProbeEntryContextNode,
  createResolveInputsNode,
} from "./nodes/context.js";
import type { DocumentDependencies, IdentificationDependencies } from "./nodes/identification.js";
import {
  createCollectEvidenceNode,
  createConfirmIdentityNode,
  createDiscoverDocumentsNode,
  createIdentifyApplicationNode,
  createReconcileModelNode,
} from "./nodes/identification.js";
import {
  createOpenApprovalReviewNode,
  createReviseTestPlanNode,
  createSuggestTestCasesNode,
  createValidateTestPlanNode,
  type PlanDependencies,
} from "./nodes/plan.js";
import { createApprovalGateNode } from "./nodes/approval-gate.js";
import { createAwaitExecutionRequestNode, createPreflightNode } from "./nodes/execution-request.js";
import { createExecuteNode, type ExecuteDependencies } from "./nodes/execute.js";
import { createVerifyNode } from "./nodes/verify.js";
import { createReportNode, type ReportDependencies } from "./nodes/report.js";
import { routeAfterApproval, routeAfterDiscovery, routeFromStatus } from "./router.js";
import { GraphStateAnnotation, type GraphState } from "./state.js";

export type NovaGraphDependencies = {
  discover: DiscoverDependencies;
  /** Omit to leave the guided flow's entry-context probe inert; the plain CLI discover path never uses it. */
  context?: ContextDependencies;
  documents?: DocumentDependencies;
  identification?: IdentificationDependencies;
  /** Omit entirely (or omit `suggester`) to keep planning fully deterministic — no model call at all. */
  plan?: PlanDependencies;
  execute: ExecuteDependencies;
  report: ReportDependencies;
  /** Path to the LangGraph checkpoint database, distinct from RunRepository's own database. */
  checkpointDatabasePath: string;
};

/** Every node the entry router may resume at. */
const ENTRY_TARGETS = [
  "resolve_inputs",
  "probe_entry_context",
  "ensure_authentication",
  "discover_documents",
  "collect_identification_evidence",
  "identify_application_with_llm",
  "confirm_application_identity",
  "discover_application",
  "suggest_test_cases",
  "validate_test_plan",
  "await_approval",
  "revise_test_plan",
  "await_execution_request",
  "execution_preflight",
  "execute_approved_tests",
  "verify",
  "generate_report",
  END,
] as const;

/**
 * Nova's single workflow. The governed spine — discover, plan, approve,
 * execute, report — is unchanged; the guided flow adds the stages in
 * front of it (input resolution, entry context, authentication,
 * documentation, evidence, identification, confirmation, reconciliation)
 * and between approval and execution (a separate execution request and a
 * preflight).
 *
 * Compiled once per process with a real SQLite checkpointer, so a crash
 * mid-node loses nothing in flight. Cross-process continuity — the CLI or
 * TUI invoking this graph again after a human made a decision — is
 * carried by the persisted TestRunState and resolved by `routeFromStatus`,
 * which resumes at the correct node every time and never re-runs a
 * completed crawl or a completed model call.
 */
export type NovaGraph = ReturnType<typeof compileNovaGraph>;

function compileNovaGraph(deps: NovaGraphDependencies) {
  const checkpointer = SqliteSaver.fromConnString(deps.checkpointDatabasePath);

  const graph = new StateGraph(GraphStateAnnotation)
    .addNode("resolve_inputs", createResolveInputsNode())
    .addNode(
      "probe_entry_context",
      createProbeEntryContextNode(
        deps.context ?? {
          // Without a configured probe the guided flow's authentication
          // question simply never fires; the graph still compiles and the
          // plain CLI path is unaffected.
          detectAuth: async () => ({ required: false }),
          discover: deps.discover.discover,
          headless: deps.discover.headless,
        },
      ),
    )
    .addNode("ensure_authentication", createEnsureAuthenticationNode())
    .addNode("discover_documents", createDiscoverDocumentsNode(deps.documents))
    .addNode("collect_identification_evidence", createCollectEvidenceNode())
    .addNode("refresh_identification_evidence", createCollectEvidenceNode({ preserveStatus: true }))
    .addNode("identify_application_with_llm", createIdentifyApplicationNode(deps.identification))
    .addNode("confirm_application_identity", createConfirmIdentityNode())
    .addNode("discover_application", createDiscoverNode(deps.discover))
    .addNode("reconcile_application_model", createReconcileModelNode())
    .addNode("suggest_test_cases", createSuggestTestCasesNode(deps.plan))
    .addNode("validate_test_plan", createValidateTestPlanNode())
    .addNode("open_approval_review", createOpenApprovalReviewNode())
    .addNode("await_approval", createApprovalGateNode())
    .addNode("revise_test_plan", createReviseTestPlanNode())
    .addNode("await_execution_request", createAwaitExecutionRequestNode())
    .addNode("execution_preflight", createPreflightNode())
    .addNode("execute_approved_tests", createExecuteNode(deps.execute))
    .addNode("verify", createVerifyNode())
    .addNode("generate_report", createReportNode(deps.report))

    // Entry: resume at whatever node the persisted status calls for.
    .addConditionalEdges(START, routeFromStatus, [...ENTRY_TARGETS])

    .addEdge("resolve_inputs", "probe_entry_context")
    // Authentication required -> stop and let the operator choose; otherwise continue.
    .addConditionalEdges("probe_entry_context", routeFromStatus, [
      "ensure_authentication",
      "discover_documents",
      END,
    ])
    .addEdge("ensure_authentication", "probe_entry_context")
    .addEdge("discover_documents", "identify_application_with_llm")
    .addEdge("collect_identification_evidence", "identify_application_with_llm")
    // Identification always stops for a human confirmation; a high-confidence,
    // non-conflicting result simply makes "Continue" the default action there.
    .addConditionalEdges("identify_application_with_llm", routeFromStatus, [
      "confirm_application_identity",
      END,
    ])
    .addEdge("confirm_application_identity", "discover_application")
    // After the full crawl: refresh evidence and reconcile the confirmed
    // model against it when the guided flow is running; otherwise behave
    // exactly like the original discover node did.
    .addConditionalEdges("discover_application", routeAfterDiscovery, [
      "refresh_identification_evidence",
      "suggest_test_cases",
      END,
    ])
    .addEdge("refresh_identification_evidence", "reconcile_application_model")
    // Conditional, not static: the objective is collected *after* the
    // application model is confirmed, so this must be able to stop and
    // wait for it rather than calling suggestion without one.
    .addConditionalEdges("reconcile_application_model", routeFromStatus, [
      "suggest_test_cases",
      "validate_test_plan",
      END,
    ])
    .addEdge("suggest_test_cases", "validate_test_plan")
    .addConditionalEdges("validate_test_plan", routeAfterValidation, ["open_approval_review", END])
    // Waiting for a human decision in the local HTML review page.
    .addEdge("open_approval_review", END)
    // approved -> stop (running it is a separate, separately audited request);
    // changes_requested -> revise; rejected -> stop.
    .addConditionalEdges("await_approval", routeAfterApproval, ["revise_test_plan", END])
    .addEdge("revise_test_plan", "suggest_test_cases")
    .addEdge("await_execution_request", "execution_preflight")
    .addEdge("execution_preflight", "execute_approved_tests")
    .addEdge("execute_approved_tests", "verify")
    .addEdge("verify", "generate_report")
    .addEdge("generate_report", END);

  return graph.compile({ checkpointer });
}

/** A plan that failed validation outright is blocked, not offered for review. */
function routeAfterValidation(state: GraphState): string {
  return state.run.status === "awaiting_approval" ? "open_approval_review" : END;
}

export function buildNovaGraph(deps: NovaGraphDependencies): NovaGraph {
  return compileNovaGraph(deps);
}

export { routeFromStatus } from "./router.js";
export type { GraphState } from "./state.js";
