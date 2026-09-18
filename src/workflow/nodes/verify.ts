import type { GraphState } from "../state.js";
import { classifyExecution } from "../verify-classifier.js";

/**
 * Node 5: verify. Deterministic assertion evaluation only — classifies
 * every execution result as passed/failed/flaky/blocked/inconclusive from
 * the evidence executeTestCase already recorded. Retries already happened
 * per the case's own declared policy during execute; this node never
 * re-runs anything, it only judges what already ran.
 */
export function createVerifyNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    const verificationResults = run.executionResults.map((execution) => classifyExecution(execution));
    const anyFailed = verificationResults.some(
      (result) => result.classification === "failed" || result.classification === "blocked",
    );

    return {
      run: {
        ...run,
        verificationResults,
        status: anyFailed ? "failed" : "completed",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "verification_completed",
            detail: {
              passed: verificationResults.filter((result) => result.classification === "passed").length,
              failed: verificationResults.filter((result) => result.classification === "failed").length,
              blocked: verificationResults.filter((result) => result.classification === "blocked").length,
              flaky: verificationResults.filter((result) => result.classification === "flaky").length,
              inconclusive: verificationResults.filter((result) => result.classification === "inconclusive")
                .length,
            },
            actor: "system",
          },
        ],
      },
    };
  };
}
