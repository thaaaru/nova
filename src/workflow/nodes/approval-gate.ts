import type { GraphState } from "../state.js";

/**
 * Node 3: approval_gate. Does not decide anything itself — the decision
 * (`run.approval`) is set by the CLI's `approve`/`reject` command before
 * the graph is invoked, coming from a human reviewer. This node's job is
 * to validate that decision is actually present and well-formed, apply
 * the corresponding status transition, and write the audit record. No
 * state-changing case can reach execute without passing through here.
 */
export function createApprovalGateNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    if (!run.approval) {
      throw new Error("approval_gate node requires run.approval to be set before it runs.");
    }
    if (!run.testPlan || run.approval.planId !== run.testPlan.id) {
      throw new Error("approval_gate node requires the approval to reference the run's current test plan.");
    }

    const status = run.approval.decision === "approved" ? "approved" : "rejected";

    return {
      run: {
        ...run,
        status,
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: run.approval.decision === "approved" ? "plan_approved" : "plan_rejected",
            detail: { reviewer: run.approval.reviewer, note: run.approval.note },
            actor: run.approval.reviewer,
          },
        ],
      },
    };
  };
}
