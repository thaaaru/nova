import { describe, expect, it } from "vitest";

import type { TestRunState } from "../src/domain/index.js";
import { buildReportData } from "../src/services/reporting/report-data-adapter.js";

function makeState(): TestRunState {
  const t0 = "2024-01-01T00:00:00.000Z";
  const t1 = "2024-01-01T00:00:05.000Z";
  const t2 = "2024-01-01T00:00:10.000Z";
  const t3 = "2024-01-01T00:00:20.000Z";
  const t4 = "2024-01-01T00:00:30.000Z";

  return {
    tenantId: "default",
    projectId: "checkout-web",
    runId: "11111111-1111-1111-1111-111111111111",
    targetManifest: {
      targetId: "demo-app",
      baseUrl: "https://shop.example.test/",
      allowedDomains: ["shop.example.test"],
      environment: "staging",
      description: "",
      runExecutionMode: "safe_test",
      createdAt: t0,
    },
    objective: "Test the checkout flow.",
    testPlan: {
      id: "plan-1",
      version: 1,
      objective: "Test the checkout flow.",
      targetManifestId: "demo-app",
      createdAt: t0,
      cases: [
        {
          id: "case-pass",
          title: "Home page loads",
          preconditions: [],
          steps: [{ kind: "navigate", url: "https://shop.example.test/", timeoutMs: 10_000 }],
          assertions: [{ kind: "titleContains", expected: "Shop" }],
          allowedDomains: ["shop.example.test"],
          executionMode: "read_only",
          riskLevel: "low",
          timeoutMs: 30_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          recoveryBudget: 2,
        },
        {
          id: "case-fail",
          title: "Checkout submit",
          preconditions: [],
          steps: [{ kind: "click", role: "button", name: "Checkout", timeoutMs: 10_000 }],
          assertions: [{ kind: "urlContains", expected: "confirmation" }],
          allowedDomains: ["shop.example.test"],
          executionMode: "state_changing",
          riskLevel: "high",
          timeoutMs: 45_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          recoveryBudget: 2,
        },
      ],
    },
    approval: { planId: "plan-1", decision: "approved", reviewer: "qa-lead", decidedAt: t1 },
    executionResults: [
      {
        caseId: "case-pass",
        attempts: 1,
        stepResults: [{ stepIndex: 0, status: "passed", durationMs: 200 }],
        assertionResults: [
          { kind: "titleContains", expected: "Shop", passed: true, observed: "Shop | Home" },
        ],
        recoveryAttempts: [],
        screenshots: [],
        consoleLogs: [],
        startedAt: t2,
        completedAt: t3,
      },
      {
        caseId: "case-fail",
        attempts: 1,
        stepResults: [
          {
            stepIndex: 0,
            status: "failed",
            error: "Checkout button locator did not resolve",
            durationMs: 500,
          },
        ],
        assertionResults: [
          { kind: "urlContains", expected: "confirmation", passed: false, observed: "cart" },
        ],
        recoveryAttempts: [
          {
            stepIndex: 0,
            checkpoint: "Checkout",
            failureSummary: "Checkout button locator did not resolve",
            evidenceSummary: "DOM changed; no backend error observed.",
            action: "Re-derive target using role button with loose name match.",
            attempt: 1,
            maxAttempts: 2,
            outcome: "exhausted",
          },
        ],
        screenshots: ["artifacts/run-1/case-fail/failure-step-0.png"],
        consoleLogs: [],
        tracePath: "artifacts/run-1/case-fail/trace-attempt-1.zip",
        startedAt: t3,
        completedAt: t4,
        error: undefined,
      },
    ],
    verificationResults: [
      { caseId: "case-pass", classification: "passed", evidenceRefs: [] },
      {
        caseId: "case-fail",
        classification: "failed",
        evidenceRefs: ["artifacts/run-1/case-fail/failure-step-0.png"],
        defectCandidate: {
          title: "case-fail: assertion mismatch",
          description: "Assertion(s) failed",
          evidenceRefs: ["artifacts/run-1/case-fail/failure-step-0.png"],
        },
      },
    ],
    artifactReferences: [],
    auditEvents: [
      { timestamp: t0, type: "discovery_completed", detail: { pageCount: 2 }, actor: "system" },
      { timestamp: t0, type: "plan_ready_for_approval", detail: { planId: "plan-1" }, actor: "system" },
      { timestamp: t1, type: "plan_approved", detail: { reviewer: "qa-lead" }, actor: "qa-lead" },
      { timestamp: t3, type: "execution_completed", detail: { caseCount: 2 }, actor: "system" },
      { timestamp: t4, type: "verification_completed", detail: { passed: 1, failed: 1 }, actor: "system" },
    ],
    status: "completed",
  };
}

describe("buildReportData", () => {
  it("derives an executive summary that matches the underlying verification results", () => {
    const report = buildReportData(makeState());
    expect(report.executiveSummary).toMatchObject({
      totalTests: 2,
      passed: 1,
      failed: 1,
      recoveryAttempts: 1,
      approvalInterventions: 1,
      defectCandidates: 1,
    });
    expect(report.executiveSummary.outcomeStatement).toContain("1 confirmed defect");
  });

  it("builds a chronological timeline with elapsed time per completed stage, skipping stages with no evidence", () => {
    const report = buildReportData(makeState());
    const byStage = new Map(report.timeline.map((stage) => [stage.stage, stage]));
    expect(byStage.get("discover")?.status).toBe("completed");
    expect(byStage.get("approval")?.status).toBe("completed");
    expect(byStage.get("report")?.status).toBe("skipped");
    expect(byStage.get("execute")?.elapsedMs).toBeGreaterThan(0);
  });

  it("produces a findings entry for the confirmed defect, distinct from the passed case", () => {
    const report = buildReportData(makeState());
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].caseId).toBe("case-fail");
    expect(report.findings[0].recoveryContinuedRun).toBe(true);
    expect(report.findings[0].observedBehavior).toBe("cart");
  });

  it("counts recovery-funnel stages consistently with the raw execution results", () => {
    const report = buildReportData(makeState());
    expect(report.charts.recoveryFunnel).toEqual({
      failuresDetected: 1,
      recoveryAttempted: 1,
      recovered: 0,
      confirmedDefect: 1,
      blocked: 0,
    });
  });

  it("redacts secret-shaped audit detail keys in the governance timeline", () => {
    const state = makeState();
    state.auditEvents.push({
      timestamp: "2024-01-01T00:00:31.000Z",
      type: "secret_resolution_attempted",
      detail: { secretId: "standard_user_password", value: "should-never-appear" },
      actor: "system",
    });
    const report = buildReportData(state);
    const entry = report.governance.redactedAuditTimeline.find(
      (e) => e.type === "secret_resolution_attempted",
    );
    expect(entry?.detail.value).toBe("[redacted]");
  });
});
