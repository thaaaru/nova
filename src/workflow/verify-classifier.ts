import type { ExecutionResult, VerificationResult } from "../domain/index.js";

const HARNESS_LIMITATION_MARKER = "unsupported without a captured response";

/**
 * Deterministic-first classification: assertions and step outcomes decide
 * everything, never a model's opinion. A defect candidate is only ever
 * created when the evidence — a failed step or a mismatched assertion —
 * actually supports one; a harness limitation (an assertion kind the MVP
 * can't yet evaluate) is reported as inconclusive, never as a false defect
 * against the application under test.
 */
export function classifyExecution(execution: ExecutionResult): VerificationResult {
  const evidenceRefs = [...execution.screenshots, ...(execution.tracePath ? [execution.tracePath] : [])];

  if (execution.error) {
    return {
      caseId: execution.caseId,
      classification: "blocked",
      evidenceRefs,
    };
  }

  const harnessLimited = execution.assertionResults.some(
    (assertion) => assertion.observed === HARNESS_LIMITATION_MARKER,
  );
  if (harnessLimited) {
    return {
      caseId: execution.caseId,
      classification: "inconclusive",
      evidenceRefs,
    };
  }

  const failedStep = execution.stepResults.find((step) => step.status === "failed");
  const failedAssertions = execution.assertionResults.filter((assertion) => !assertion.passed);

  if (failedStep || failedAssertions.length > 0) {
    const description = failedStep
      ? `Step ${failedStep.stepIndex} failed: ${failedStep.error ?? "unknown error"}`
      : `Assertion(s) failed: ${failedAssertions.map((assertion) => `${assertion.kind} expected "${assertion.expected}", observed "${assertion.observed ?? "(none)"}"`).join("; ")}`;

    return {
      caseId: execution.caseId,
      classification: "failed",
      evidenceRefs,
      defectCandidate: {
        title: `${execution.caseId}: ${failedStep ? "step failure" : "assertion mismatch"}`,
        description,
        evidenceRefs,
      },
    };
  }

  if (execution.attempts > 1) {
    return { caseId: execution.caseId, classification: "flaky", evidenceRefs };
  }

  return { caseId: execution.caseId, classification: "passed", evidenceRefs };
}
