import { END } from "@langchain/langgraph";

import type { TestRunState } from "../domain/index.js";
import type { GraphState } from "./state.js";

/**
 * The graph's only routing logic, used both as the entry point (which
 * node a fresh `.invoke()` should resume at, from the persisted run's
 * status) and after every node (whether the next required external input
 * — an authentication choice, an identification confirmation, an
 * objective, an approval decision, an execution request — is already
 * present, or whether the graph should stop and wait for the presentation
 * layer to supply it).
 *
 * Every branch here is a plain status/field check. None of them is a
 * model's opinion, and there is no second state machine anywhere else in
 * the product: stopping at END *is* Nova's interrupt, and the SQLite
 * checkpointer plus the persisted TestRunState is what makes the next
 * `.invoke()` resume exactly where this one stopped, without repeating a
 * completed crawl or a completed model call.
 */
export function routeFromStatus(state: GraphState): string {
  const run: TestRunState = state.run;
  switch (run.status) {
    case "new":
      return "resolve_inputs";
    case "context_discovery":
      return "probe_entry_context";
    case "authentication_required":
      // Waits for the operator to choose a session, a saved profile, or
      // public-areas-only. Nothing about that choice is inferable here.
      return run.authenticationMode || run.targetManifest.storageStatePath ? "ensure_authentication" : END;
    case "authenticated":
      return "probe_entry_context";
    case "document_discovery":
      return "discover_documents";
    case "application_identification":
      return run.evidencePackage ? "identify_application_with_llm" : "collect_identification_evidence";
    case "identification_confirmation":
      return run.identification?.confirmedBy ? "confirm_application_identity" : END;
    case "discovering":
      return "discover_application";
    case "planning":
      if (!run.objective) {
        return END;
      }
      return run.testPlan && run.suggestions ? "validate_test_plan" : "suggest_test_cases";
    case "awaiting_approval":
      return run.approval ? "await_approval" : END;
    case "changes_requested":
      return "revise_test_plan";
    case "approved":
      // Approval is never execution: a run only leaves this state when a
      // separate execution request exists. `nova run --plan` (the
      // pre-existing CLI path) supplies no request and goes straight to
      // execute, exactly as it always has.
      if (run.executionRequest && !hasAuditEvent(run, "execution_requested")) {
        return "await_execution_request";
      }
      return "execute_approved_tests";
    case "execution_requested":
      return "execution_preflight";
    case "preflight":
      return "execute_approved_tests";
    case "executing":
      return "verify";
    case "verifying":
      return "generate_report";
    case "rejected":
    case "paused":
    case "stopped":
    case "completed":
    case "failed":
    case "blocked":
      return END;
    default:
      return END;
  }
}

/**
 * After the full crawl. The guided flow refreshes its evidence and
 * reconciles the confirmed application model against it; the plain
 * `nova discover` path (no identification) behaves exactly as it always
 * has — stop and wait for an objective, or go straight to planning.
 */
export function routeAfterDiscovery(state: GraphState): string {
  if (state.run.identification?.confirmedBy) {
    return "refresh_identification_evidence";
  }
  return state.run.objective ? "suggest_test_cases" : END;
}

/**
 * Approving is never executing. An approved or rejected run stops here;
 * only a "changes requested" decision continues, into revision.
 */
export function routeAfterApproval(state: GraphState): string {
  return state.run.status === "changes_requested" ? "revise_test_plan" : END;
}

function hasAuditEvent(run: TestRunState, type: string): boolean {
  return run.auditEvents.some((event) => event.type === type);
}
