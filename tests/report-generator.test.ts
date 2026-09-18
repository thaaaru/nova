import { describe, expect, it } from "vitest";

import type { TestRunState } from "../src/domain/index.js";
import {
  buildJsonReport,
  buildJUnitReport,
  buildMarkdownReport,
} from "../src/services/reporting/report-generator.js";

function makeState(): TestRunState {
  return {
    tenantId: "default",
    projectId: "default",
    runId: "11111111-1111-1111-1111-111111111111",
    targetManifest: {
      targetId: "demo-app",
      baseUrl: "https://shop.example.test/",
      allowedDomains: ["shop.example.test"],
      environment: "staging",
      description: "",
      runExecutionMode: "safe_test",
      createdAt: new Date().toISOString(),
    },
    objective: "Test the checkout flow.",
    testPlan: {
      id: "11111111-1111-1111-1111-111111111111",
      version: 1,
      objective: "Test the checkout flow.",
      targetManifestId: "demo-app",
      createdAt: new Date().toISOString(),
      cases: [
        {
          id: "case-pass",
          title: "Home page loads",
          preconditions: [],
          steps: [{ kind: "navigate", url: "https://shop.example.test/", timeoutMs: 10_000 }],
          assertions: [{ kind: "urlContains", expected: "shop.example.test" }],
          allowedDomains: ["shop.example.test"],
          executionMode: "read_only",
          riskLevel: "low",
          timeoutMs: 30_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          recoveryBudget: 2,
        },
        {
          id: "case-fail",
          title: "Checkout succeeds",
          preconditions: [],
          steps: [{ kind: "click", selector: "#pay", timeoutMs: 10_000 }],
          assertions: [{ kind: "titleContains", expected: "Thank you" }],
          allowedDomains: ["shop.example.test"],
          executionMode: "state_changing",
          riskLevel: "medium",
          timeoutMs: 30_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          recoveryBudget: 2,
        },
      ],
    },
    executionResults: [
      {
        caseId: "case-pass",
        attempts: 1,
        stepResults: [{ stepIndex: 0, status: "passed", durationMs: 5 }],
        assertionResults: [{ kind: "urlContains", expected: "shop.example.test", passed: true }],
        recoveryAttempts: [],
        screenshots: [],
        consoleLogs: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      {
        caseId: "case-fail",
        attempts: 1,
        stepResults: [{ stepIndex: 0, status: "failed", error: "element not found", durationMs: 10_000 }],
        assertionResults: [],
        recoveryAttempts: [],
        screenshots: ["/tmp/case-fail.png"],
        consoleLogs: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ],
    verificationResults: [
      { caseId: "case-pass", classification: "passed", evidenceRefs: [] },
      {
        caseId: "case-fail",
        classification: "failed",
        evidenceRefs: ["/tmp/case-fail.png"],
        defectCandidate: {
          title: "case-fail: step failure",
          description: "Step 0 failed: element not found",
          evidenceRefs: ["/tmp/case-fail.png"],
        },
      },
    ],
    artifactReferences: [],
    auditEvents: [],
    status: "failed",
  };
}

describe("buildJsonReport", () => {
  it("links every finding back to its evidence and carries run identity", () => {
    const report = buildJsonReport(makeState());
    expect(report.runId).toBe("11111111-1111-1111-1111-111111111111");
    expect(report.status).toBe("failed");
    const failedCase = report.cases.find((c) => c.caseId === "case-fail");
    expect(failedCase?.evidenceRefs).toEqual(["/tmp/case-fail.png"]);
    expect(failedCase?.defectCandidate?.title).toContain("case-fail");
  });
});

describe("buildJUnitReport", () => {
  it("reports the correct failure count and includes a failure element for the failing case", () => {
    const xml = buildJUnitReport(makeState());
    expect(xml).toContain('tests="2" failures="1"');
    expect(xml).toContain('name="Checkout succeeds"');
    expect(xml).toContain("<failure");
  });

  it("escapes XML-sensitive characters in case titles", () => {
    const state = makeState();
    state.testPlan!.cases[0].title = 'Case with <tag> & "quotes"';
    const xml = buildJUnitReport(state);
    expect(xml).not.toContain("<tag>");
    expect(xml).toContain("&lt;tag&gt;");
  });
});

describe("buildMarkdownReport", () => {
  it("summarizes pass/fail counts and lists the defect candidate", () => {
    const markdown = buildMarkdownReport(makeState());
    expect(markdown).toContain("1 passed, 1 failed");
    expect(markdown).toContain("Defect candidate");
    expect(markdown).toContain("element not found");
  });
});
