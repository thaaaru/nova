import { END } from "@langchain/langgraph";

import type { TestRunState } from "../domain/index.js";
import type { GraphState } from "./state.js";

/**
 * The graph's only routing logic, used both as the entry point (decides
 * which node a fresh `.invoke()` should resume at, based on the persisted
 * run's current status) and after discover/plan (decides whether the next
 * required external input — objective, then an approval decision — is
 * already present, or whether the graph should stop and wait for the next
 * CLI/MCP call to supply it). Every branch here is a plain status/field
 * check, never a model's opinion.
 */
export function routeFromStatus(state: GraphState): string {
  const run: TestRunState = state.run;
  switch (run.status) {
    case "discovering":
      return "discover";
    case "planning":
      return run.objective ? "plan" : END;
    case "awaiting_approval":
      return run.approval ? "approval_gate" : END;
    case "approved":
      return "execute";
    case "executing":
      return "verify";
    case "verifying":
      return "report";
    case "rejected":
    case "completed":
    case "failed":
    case "blocked":
      return END;
    default:
      return END;
  }
}
