import type { GraphState } from "../state.js";

/**
 * await_approval. Does not decide anything itself — the decision
 * (`run.approval`, and for HTML reviews the immutable
 * `run.approvedPlanSnapshot`) is produced by a human before the graph is
 * invoked. This node validates the decision is present, references this
 * run's current plan *and* its current plan hash, applies the
 * corresponding status transition, and writes the audit record.
 *
 * Approving is never executing: an approved run stops here, and running
 * it requires a separate, separately audited execution request.
 */
export function createApprovalGateNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    if (!run.approval) {
      throw new Error("await_approval requires run.approval to be set before it runs.");
    }
    if (!run.testPlan || run.approval.planId !== run.testPlan.id) {
      throw new Error("await_approval requires the approval to reference the run's current test plan.");
    }
    // A decision minted from the HTML page carries the exact plan hash
    // the reviewer saw; if the plan has since been revised, that approval
    // is stale and must not be honoured.
    if (run.approvedPlanSnapshot && run.planHash && run.approvedPlanSnapshot.planHash !== run.planHash) {
      throw new Error("await_approval refused a decision recorded against a different version of this plan.");
    }

    const status =
      run.approval.decision === "approved"
        ? "approved"
        : run.approval.decision === "changes_requested"
          ? "changes_requested"
          : "rejected";

    return {
      run: {
        ...run,
        status,
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type:
              run.approval.decision === "approved"
                ? "plan_approved"
                : run.approval.decision === "changes_requested"
                  ? "plan_changes_requested"
                  : "plan_rejected",
            detail: {
              reviewer: run.approval.reviewer,
              note: run.approval.note,
              approvalId: run.approval.approvalId,
              planHash: run.planHash,
              selectedCount: run.approval.selectedTestCaseIds?.length,
              excludedCount: run.approvedPlanSnapshot?.excludedTestCaseIds.length,
            },
            actor: run.approval.reviewer,
          },
        ],
      },
    };
  };
}
