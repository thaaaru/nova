import { END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import type { DiscoverDependencies } from "./nodes/discover.js";
import { createDiscoverNode } from "./nodes/discover.js";
import { createPlanNode, type PlanDependencies } from "./nodes/plan.js";
import { createApprovalGateNode } from "./nodes/approval-gate.js";
import { createExecuteNode, type ExecuteDependencies } from "./nodes/execute.js";
import { createVerifyNode } from "./nodes/verify.js";
import { createReportNode, type ReportDependencies } from "./nodes/report.js";
import { routeFromStatus } from "./router.js";
import { GraphStateAnnotation } from "./state.js";

export type NovaGraphDependencies = {
  discover: DiscoverDependencies;
  /** Omit entirely (or omit generateCases) to keep the plan node fully deterministic — no DeepSeek call at all. */
  plan?: PlanDependencies;
  execute: ExecuteDependencies;
  report: ReportDependencies;
  /** Path to the LangGraph checkpoint database, distinct from RunRepository's own database. */
  checkpointDatabasePath: string;
};

/**
 * The canonical discover -> plan -> approval_gate -> execute -> verify ->
 * report graph. Compiled once per process with a real SQLite checkpointer
 * for durability, so a crash mid-node doesn't lose in-flight progress
 * within a single `.invoke()` call. Cross-command continuity (the CLI
 * invoking this graph again in a later process, e.g. `discover` then a
 * separate `plan` command) is handled by RunRepository, not by LangGraph's
 * interrupt/resume machinery — the graph's own entry router
 * (routeFromStatus) resumes at the correct node from the persisted
 * TestRunState's `status` field every time.
 */
export type NovaGraph = ReturnType<typeof compileNovaGraph>;

function compileNovaGraph(deps: NovaGraphDependencies) {
  const checkpointer = SqliteSaver.fromConnString(deps.checkpointDatabasePath);

  const graph = new StateGraph(GraphStateAnnotation)
    .addNode("discover", createDiscoverNode(deps.discover))
    .addNode("plan", createPlanNode(deps.plan))
    .addNode("approval_gate", createApprovalGateNode())
    .addNode("execute", createExecuteNode(deps.execute))
    .addNode("verify", createVerifyNode())
    .addNode("report", createReportNode(deps.report))
    .addConditionalEdges(START, routeFromStatus, ["discover", "plan", "approval_gate", "execute", END])
    .addConditionalEdges("discover", routeFromStatus, ["plan", END])
    .addConditionalEdges("plan", routeFromStatus, ["approval_gate", END])
    // approval_gate always stops here regardless of decision — running the
    // approved plan is a deliberately separate command/invocation
    // (`nova run --plan <id>`), never an automatic side effect of approval.
    .addEdge("approval_gate", END)
    .addEdge("execute", "verify")
    .addEdge("verify", "report")
    .addEdge("report", END);

  return graph.compile({ checkpointer });
}

export function buildNovaGraph(deps: NovaGraphDependencies): NovaGraph {
  return compileNovaGraph(deps);
}

export { routeFromStatus } from "./router.js";
export type { GraphState } from "./state.js";
