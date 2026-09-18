import { describe, expect, it } from "vitest";

import type { ExecutionResult } from "../src/domain/index.js";
import { classifyExecution } from "../src/workflow/verify-classifier.js";

function baseExecution(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    caseId: "case-1",
    attempts: 1,
    stepResults: [{ stepIndex: 0, status: "passed", durationMs: 5 }],
    assertionResults: [
      { kind: "urlContains", expected: "example.test", passed: true, observed: "https://example.test/" },
    ],
    recoveryAttempts: [],
    screenshots: [],
    consoleLogs: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("classifyExecution", () => {
  it("classifies a clean single-attempt pass as passed", () => {
    expect(classifyExecution(baseExecution()).classification).toBe("passed");
  });

  it("classifies a run that only passed on retry as flaky, not passed", () => {
    expect(classifyExecution(baseExecution({ attempts: 2 })).classification).toBe("flaky");
  });

  it("classifies a policy-blocked execution as blocked, never failed", () => {
    const result = classifyExecution(baseExecution({ error: "Navigation blocked: attacker.test" }));
    expect(result.classification).toBe("blocked");
    expect(result.defectCandidate).toBeUndefined();
  });

  it("creates a defect candidate backed by evidence when a step fails", () => {
    const result = classifyExecution(
      baseExecution({
        stepResults: [
          { stepIndex: 0, status: "failed", error: "Timeout locating button", durationMs: 10_000 },
        ],
        screenshots: ["/tmp/failure.png"],
      }),
    );
    expect(result.classification).toBe("failed");
    expect(result.defectCandidate?.evidenceRefs).toContain("/tmp/failure.png");
  });

  it("creates a defect candidate when an assertion mismatches even though every step passed", () => {
    const result = classifyExecution(
      baseExecution({
        assertionResults: [
          { kind: "titleContains", expected: "Checkout", passed: false, observed: "Error 500" },
        ],
      }),
    );
    expect(result.classification).toBe("failed");
    expect(result.defectCandidate?.description).toContain("Checkout");
  });

  it("reports a harness limitation as inconclusive, never as a false defect against the app", () => {
    const result = classifyExecution(
      baseExecution({
        assertionResults: [
          {
            kind: "statusCode",
            expected: "200",
            passed: false,
            observed: "unsupported without a captured response",
          },
        ],
      }),
    );
    expect(result.classification).toBe("inconclusive");
    expect(result.defectCandidate).toBeUndefined();
  });
});
