import type { TestPlan } from "../../domain/index.js";
import type { GraphState } from "../state.js";

/**
 * The two nodes that stand between an approved plan and a running
 * browser.
 *
 * `await_execution_request` refuses to move until a separate, explicit
 * execution request exists — approving a plan never starts a run. The
 * request is re-verified here against the approval it claims to carry,
 * so a request cannot be re-pointed at a different plan, target,
 * environment, scope, or set of cases than the one a human approved.
 *
 * `execution_preflight` narrows the plan to exactly the approved and
 * requested case ids. Everything downstream executes from that
 * narrowed, immutable specification.
 */

export function createAwaitExecutionRequestNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    const request = run.executionRequest;
    if (!request) {
      throw new Error("await_execution_request requires an execution request before it runs.");
    }
    if (!run.testPlan || !run.planHash) {
      throw new Error("await_execution_request requires a validated plan with a plan hash.");
    }
    if (run.approval?.decision !== "approved") {
      throw new Error("await_execution_request refused: this plan has not been approved.");
    }
    if (request.planId !== run.testPlan.id || request.planHash !== run.planHash) {
      throw new Error("await_execution_request refused: the request does not match the approved plan.");
    }
    const snapshot = run.approvedPlanSnapshot;
    if (snapshot) {
      if (request.approvalId !== snapshot.approvalId || request.planHash !== snapshot.planHash) {
        throw new Error("await_execution_request refused: the request does not match the recorded approval.");
      }
      if (request.target !== snapshot.target || request.environment !== snapshot.environment) {
        throw new Error("await_execution_request refused: target/environment differ from the approval.");
      }
      const approved = new Set(
        snapshot.selectedTestCaseIds.length > 0
          ? snapshot.selectedTestCaseIds
          : run.testPlan.cases.map((testCase) => testCase.id),
      );
      const unapproved = request.selectedTestCaseIds.filter((id) => !approved.has(id));
      if (unapproved.length > 0) {
        throw new Error(
          `await_execution_request refused: case(s) not covered by the approval: ${unapproved.join(", ")}`,
        );
      }
    }

    return {
      run: {
        ...run,
        status: "execution_requested",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "execution_requested",
            detail: {
              executionRequestId: request.executionRequestId,
              approvalId: request.approvalId,
              planHash: request.planHash,
              caseCount: request.selectedTestCaseIds.length,
              idempotencyKey: request.idempotencyKey,
            },
            actor: request.requestedBy,
          },
        ],
      },
    };
  };
}

export function createPreflightNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    const request = run.executionRequest;
    if (!request || !run.testPlan) {
      throw new Error("execution_preflight requires an execution request and a validated plan.");
    }

    const selected = new Set(request.selectedTestCaseIds);
    const cases = run.testPlan.cases.filter((testCase) => selected.has(testCase.id));
    if (cases.length === 0) {
      throw new Error("execution_preflight refused: the execution request selected no runnable case.");
    }
    const plan: TestPlan = { ...run.testPlan, cases };
    const sideEffecting = cases.filter((testCase) => testCase.executionMode === "state_changing");

    return {
      run: {
        ...run,
        testPlan: plan,
        status: "approved",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "execution_preflight_passed",
            detail: {
              caseCount: cases.length,
              sideEffectingCount: sideEffecting.length,
              runExecutionMode: run.targetManifest.runExecutionMode,
              environment: run.targetManifest.environment,
            },
            actor: "system",
          },
        ],
      },
    };
  };
}
