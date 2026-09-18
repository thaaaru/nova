import { describe, expect, it } from "vitest";

import type { TestRunState } from "../../src/domain/index.js";
import { buildRunViewModel } from "../../src/tui/services/view-model.js";

const NOW = "2024-01-01T00:00:00.000Z";

function baseManifest() {
  return {
    targetId: "demo-app",
    baseUrl: "https://shop.example.test/",
    allowedDomains: ["shop.example.test"],
    environment: "staging",
    description: "",
    runExecutionMode: "safe_test" as const,
    createdAt: NOW,
  };
}

function baseRun(overrides: Partial<TestRunState> = {}): TestRunState {
  return {
    tenantId: "default",
    projectId: "checkout-web",
    runId: "11111111-1111-1111-1111-111111111111",
    targetManifest: baseManifest(),
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [],
    status: "discovering",
    ...overrides,
  };
}

function plan(caseCount = 2) {
  return {
    id: "plan-1",
    version: 1,
    objective: "Test the checkout flow.",
    targetManifestId: "demo-app",
    createdAt: NOW,
    cases: Array.from({ length: caseCount }, (_, index) => ({
      id: `case-${index}`,
      title: `Case ${index}`,
      preconditions: [],
      steps: [{ kind: "navigate" as const, url: "https://shop.example.test/", timeoutMs: 10_000 }],
      assertions: [{ kind: "titleContains" as const, expected: "Shop" }],
      allowedDomains: ["shop.example.test"],
      executionMode: "read_only" as const,
      riskLevel: "low" as const,
      timeoutMs: 30_000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      recoveryBudget: 2,
    })),
  };
}

function discoverySnapshot() {
  return {
    runId: "11111111-1111-1111-1111-111111111111",
    targetUrl: "https://shop.example.test/",
    visitedUrls: ["https://shop.example.test/"],
    pages: [],
    apiEndpoints: [],
    capturedAt: NOW,
  };
}

describe("buildRunViewModel", () => {
  it("returns an onboarding view model when there is no run yet", () => {
    const viewModel = buildRunViewModel(undefined, "standard");
    expect(viewModel.runId).toBeUndefined();
    expect(viewModel.blockers).toContain("No run yet — start guided setup to configure a target.");
    expect(viewModel.nextActions).toHaveLength(1);
    expect(viewModel.nextActions[0]?.id).toBe("guided-setup");
    expect(viewModel.testCounts.planned).toBe(0);
  });

  it("surfaces 'discover first' as the next action when a run has no discovery snapshot", () => {
    const viewModel = buildRunViewModel(baseRun({ status: "discovering" }), "standard");
    expect(viewModel.nextActions[0]?.id).toBe("discover");
    expect(viewModel.blockers).toContain("No discovery yet — run discover before planning.");
  });

  it("surfaces 'generate plan' once discovered but not yet planned", () => {
    const run = baseRun({ status: "planning", discoverySnapshot: discoverySnapshot() });
    const viewModel = buildRunViewModel(run, "standard");
    expect(viewModel.nextActions[0]?.id).toBe("plan");
    expect(viewModel.blockers).toContain("No plan yet — discover first, then plan.");
  });

  it("surfaces 'awaiting approval' once a plan exists but has not been decided", () => {
    const run = baseRun({
      status: "awaiting_approval",
      discoverySnapshot: discoverySnapshot(),
      testPlan: plan(),
    });
    const viewModel = buildRunViewModel(run, "standard");
    expect(viewModel.nextActions[0]?.id).toBe("approve");
    expect(viewModel.blockers).toContain("Awaiting approval — the plan cannot execute until reviewed.");
    expect(viewModel.testCounts.planned).toBe(2);
  });

  it("surfaces 'return to planning' when the plan was rejected", () => {
    const run = baseRun({
      status: "rejected",
      discoverySnapshot: discoverySnapshot(),
      testPlan: plan(),
      approval: {
        planId: "plan-1",
        decision: "rejected",
        reviewer: "qa-lead",
        decidedAt: NOW,
        note: "too risky",
      },
    });
    const viewModel = buildRunViewModel(run, "standard");
    expect(viewModel.nextActions[0]?.id).toBe("replan");
    expect(viewModel.blockers.some((blocker) => blocker.includes("too risky"))).toBe(true);
  });

  it("surfaces 'execute' once approved", () => {
    const run = baseRun({
      status: "approved",
      discoverySnapshot: discoverySnapshot(),
      testPlan: plan(),
      approval: { planId: "plan-1", decision: "approved", reviewer: "qa-lead", decidedAt: NOW },
    });
    const viewModel = buildRunViewModel(run, "standard");
    expect(viewModel.nextActions[0]?.id).toBe("run");
  });

  it("surfaces 'open report' once completed, with correct pass/fail counts", () => {
    const run = baseRun({
      status: "completed",
      discoverySnapshot: discoverySnapshot(),
      testPlan: plan(),
      approval: { planId: "plan-1", decision: "approved", reviewer: "qa-lead", decidedAt: NOW },
      verificationResults: [
        { caseId: "case-0", classification: "passed", evidenceRefs: [] },
        { caseId: "case-1", classification: "failed", evidenceRefs: [] },
      ],
    });
    const viewModel = buildRunViewModel(run, "standard");
    expect(viewModel.nextActions[0]?.id).toBe("report");
    expect(viewModel.testCounts).toMatchObject({ planned: 2, passed: 1, failed: 1, pending: 0 });
  });

  it("marks blocked runs with a blocker and no automatic next action beyond investigation", () => {
    const viewModel = buildRunViewModel(baseRun({ status: "blocked", testPlan: plan() }), "standard");
    expect(viewModel.blockers).toContain(
      "Run is blocked — check the event feed for the policy or execution reason.",
    );
  });

  it("only surfaces active recovery state from execution results with a non-recovered outcome while executing", () => {
    const run = baseRun({
      status: "executing",
      testPlan: plan(1),
      executionResults: [
        {
          caseId: "case-0",
          attempts: 1,
          stepResults: [],
          assertionResults: [],
          recoveryAttempts: [
            {
              stepIndex: 0,
              checkpoint: "Checkout",
              failureSummary: "Locator missing",
              evidenceSummary: "DOM changed",
              action: "Retry with role locator",
              attempt: 1,
              maxAttempts: 2,
              outcome: "exhausted",
            },
          ],
          screenshots: [],
          consoleLogs: [],
          startedAt: NOW,
          completedAt: NOW,
        },
      ],
    });
    const viewModel = buildRunViewModel(run, "standard");
    expect(viewModel.recovery.active).toBe(true);
    expect(viewModel.recovery.caseId).toBe("case-0");
    expect(viewModel.recovery.attempt).toBe(1);
  });
});
