import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DiscoverySnapshot,
  ExecutionResult,
  TargetManifest,
  TestRunState,
} from "../src/domain/index.js";
import { buildNovaGraph, type NovaGraph } from "../src/workflow/graph.js";

const manifest: TargetManifest = {
  targetId: "demo-app",
  baseUrl: "https://shop.example.test/",
  allowedDomains: ["shop.example.test"],
  environment: "local",
  description: "",
  runExecutionMode: "safe_test",
  createdAt: new Date().toISOString(),
};

const snapshot: DiscoverySnapshot = {
  runId: "placeholder",
  targetUrl: manifest.baseUrl,
  visitedUrls: [manifest.baseUrl],
  pages: [
    {
      url: manifest.baseUrl,
      title: "Demo Shop",
      forms: [],
      buttons: [],
      links: [],
      consoleErrors: [],
    },
  ],
  apiEndpoints: [],
  capturedAt: new Date().toISOString(),
};

function baseRun(): TestRunState {
  const runId = randomUUID();
  return {
    tenantId: "default",
    projectId: "default",
    runId,
    targetManifest: manifest,
    status: "discovering",
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [],
  };
}

let tempDir: string;
let graph: NovaGraph;
let executedCaseIds: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-graph-test-"));
  executedCaseIds = [];
  graph = buildNovaGraph({
    discover: {
      discover: async ({ runId }) => ({ ...snapshot, runId }),
    },
    execute: {
      executeTestCase: async ({ testCase }) => {
        executedCaseIds.push(testCase.id);
        const result: ExecutionResult = {
          caseId: testCase.id,
          attempts: 1,
          stepResults: [{ stepIndex: 0, status: "passed", durationMs: 1 }],
          assertionResults: [
            { kind: "urlContains", expected: "shop.example.test", passed: true, observed: manifest.baseUrl },
          ],
          recoveryAttempts: [],
          screenshots: [],
          consoleLogs: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
        return result;
      },
      secretResolver: { resolve: () => undefined },
      artifactsDirectory: tempDir,
    },
    report: { artifactsDirectory: tempDir },
    checkpointDatabasePath: ":memory:",
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Nova graph transitions", () => {
  it("stops after discover when no objective is supplied yet", async () => {
    const run = baseRun();
    const result = await graph.invoke({ run }, { configurable: { thread_id: run.runId } });

    expect(result.run.status).toBe("planning");
    expect(result.run.discoverySnapshot).toBeDefined();
    expect(result.run.testPlan).toBeUndefined();
  });

  it("proceeds straight to plan on a fresh invocation once objective is present, and stops for approval", async () => {
    const run = { ...baseRun(), status: "planning" as const, objective: "Test the checkout flow." };
    const withSnapshot = { ...run, discoverySnapshot: { ...snapshot, runId: run.runId } };
    const result = await graph.invoke({ run: withSnapshot }, { configurable: { thread_id: run.runId } });

    expect(result.run.status).toBe("awaiting_approval");
    expect(result.run.testPlan).toBeDefined();
    expect(result.run.testPlan?.cases.length).toBeGreaterThan(0);
  });

  it("stops at approval_gate and never auto-executes on the same invocation as approval", async () => {
    const run = baseRun();
    const planId = run.runId;
    const awaitingApproval: TestRunState = {
      ...run,
      status: "awaiting_approval",
      discoverySnapshot: { ...snapshot, runId: run.runId },
      objective: "Test the checkout flow.",
      testPlan: {
        id: planId,
        version: 1,
        objective: "Test the checkout flow.",
        targetManifestId: manifest.targetId,
        createdAt: new Date().toISOString(),
        cases: [
          {
            id: "case-1",
            title: "Case",
            preconditions: [],
            steps: [{ kind: "navigate", url: manifest.baseUrl, timeoutMs: 10_000 }],
            assertions: [{ kind: "urlContains", expected: "shop.example.test" }],
            allowedDomains: manifest.allowedDomains,
            executionMode: "read_only",
            riskLevel: "low",
            timeoutMs: 30_000,
            retryPolicy: { maxAttempts: 1, backoffMs: 0 },
            recoveryBudget: 2,
          },
        ],
      },
      approval: { planId, decision: "approved", reviewer: "qa-lead", decidedAt: new Date().toISOString() },
    };

    const result = await graph.invoke({ run: awaitingApproval }, { configurable: { thread_id: run.runId } });

    expect(result.run.status).toBe("approved");
    expect(executedCaseIds).toEqual([]); // execute must not run within the same invocation as approval
  });

  it("rejects and stops the graph on the next invocation too, never reaching execute", async () => {
    const run = baseRun();
    const planId = run.runId;
    const testPlan = {
      id: planId,
      version: 1,
      objective: "Test the checkout flow.",
      targetManifestId: manifest.targetId,
      createdAt: new Date().toISOString(),
      cases: [
        {
          id: "case-1",
          title: "Case",
          preconditions: [],
          steps: [{ kind: "navigate" as const, url: manifest.baseUrl, timeoutMs: 10_000 }],
          assertions: [{ kind: "urlContains" as const, expected: "shop.example.test" }],
          allowedDomains: manifest.allowedDomains,
          executionMode: "state_changing" as const,
          riskLevel: "medium" as const,
          timeoutMs: 30_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          recoveryBudget: 2,
        },
      ],
    };
    const rejected: TestRunState = {
      ...run,
      status: "awaiting_approval",
      testPlan,
      approval: { planId, decision: "rejected", reviewer: "qa-lead", decidedAt: new Date().toISOString() },
    };

    const afterGate = await graph.invoke({ run: rejected }, { configurable: { thread_id: run.runId } });
    expect(afterGate.run.status).toBe("rejected");

    // A later invocation against a rejected run must route straight to END.
    const secondInvoke = await graph.invoke(
      { run: afterGate.run },
      { configurable: { thread_id: run.runId } },
    );
    expect(secondInvoke.run.status).toBe("rejected");
    expect(executedCaseIds).toEqual([]);
  });

  it("runs execute -> verify -> report in one invocation once status is approved, and blocks a case outside scope", async () => {
    const run = baseRun();
    const planId = run.runId;
    const approved: TestRunState = {
      ...run,
      status: "approved",
      testPlan: {
        id: planId,
        version: 1,
        objective: "Test the checkout flow.",
        targetManifestId: manifest.targetId,
        createdAt: new Date().toISOString(),
        cases: [
          {
            id: "in-scope-case",
            title: "In-scope case",
            preconditions: [],
            steps: [{ kind: "navigate", url: manifest.baseUrl, timeoutMs: 10_000 }],
            assertions: [{ kind: "urlContains", expected: "shop.example.test" }],
            allowedDomains: manifest.allowedDomains,
            executionMode: "read_only",
            riskLevel: "low",
            timeoutMs: 30_000,
            retryPolicy: { maxAttempts: 1, backoffMs: 0 },
            recoveryBudget: 2,
          },
          {
            id: "out-of-scope-case",
            title: "Case that declares a domain outside the manifest",
            preconditions: [],
            steps: [{ kind: "navigate", url: "https://attacker.test/", timeoutMs: 10_000 }],
            assertions: [{ kind: "urlContains", expected: "attacker.test" }],
            allowedDomains: ["attacker.test"],
            executionMode: "read_only",
            riskLevel: "low",
            timeoutMs: 30_000,
            retryPolicy: { maxAttempts: 1, backoffMs: 0 },
            recoveryBudget: 2,
          },
        ],
      },
      approval: { planId, decision: "approved", reviewer: "qa-lead", decidedAt: new Date().toISOString() },
    };

    const result = await graph.invoke({ run: approved }, { configurable: { thread_id: run.runId } });

    expect(executedCaseIds).toEqual(["in-scope-case"]); // the out-of-scope case was blocked before executeTestCase ever ran
    expect(result.run.verificationResults).toHaveLength(2);
    const outOfScopeResult = result.run.verificationResults.find((v) => v.caseId === "out-of-scope-case");
    expect(outOfScopeResult?.classification).toBe("blocked");
    expect(result.run.status).toBe("failed"); // a blocked case fails the overall run
    expect(result.run.artifactReferences.length).toBeGreaterThan(0); // report node ran and registered evidence
  });
});
