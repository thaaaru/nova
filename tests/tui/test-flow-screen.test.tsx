import { randomUUID } from "node:crypto";

import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import type { ApprovedPlanSnapshot, TestPlan, TestRunState } from "../../src/domain/index.js";
import type { NovaRuntime } from "../../src/cli/context.js";
import { TestFlowScreen } from "../../src/tui/screens/TestFlowScreen.js";
import { sha256Of } from "../../src/services/hash.js";

/**
 * The guided screen's two hand-off contracts, both of which were broken
 * in ways no service-level test could see:
 *
 *  - Enter on a decision gate must ignore a keystroke that was already
 *    buffered when the screen mounted (a leftover Return from the shell,
 *    or from the previous screen).
 *  - Pressing Enter on "run approved tests" must hand the *work* to the
 *    live execution screen, not run it here and pass a finished run —
 *    the live screen would then fall back to `runExecution`, which
 *    rejects anything no longer sitting at "approved".
 */

const plan: TestPlan = {
  id: "plan-1",
  version: 1,
  objective: "Confirm the storefront still loads",
  targetManifestId: "shop.example.test",
  createdAt: new Date().toISOString(),
  cases: [
    {
      id: "case-a",
      title: "Storefront loads",
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
  ],
};

const planHash = sha256Of(plan);

const approvedPlanSnapshot: ApprovedPlanSnapshot = {
  approvalId: "APV-TEST",
  planId: plan.id,
  planHash,
  decision: "approved",
  reviewer: "qa-lead",
  decidedAt: new Date().toISOString(),
  selectedTestCaseIds: ["case-a"],
  excludedTestCaseIds: [],
  comment: "",
  target: "https://shop.example.test/",
  environment: "staging",
  scopeDomains: ["shop.example.test"],
  projectId: "default",
  policyVersion: "policy-1",
  snapshotHash: sha256Of({ approvalId: "APV-TEST" }),
};

function approvedRun(): TestRunState {
  return {
    tenantId: "default",
    projectId: "default",
    runId: randomUUID(),
    targetManifest: {
      targetId: "shop.example.test",
      baseUrl: "https://shop.example.test/",
      allowedDomains: ["shop.example.test"],
      environment: "staging",
      description: "",
      runExecutionMode: "safe_test",
      createdAt: new Date().toISOString(),
    },
    objective: plan.objective,
    status: "approved",
    testPlan: plan,
    planHash,
    approvedPlanSnapshot,
    approval: {
      planId: plan.id,
      decision: "approved",
      reviewer: "qa-lead",
      decidedAt: approvedPlanSnapshot.decidedAt,
      approvalId: approvedPlanSnapshot.approvalId,
      selectedTestCaseIds: ["case-a"],
    },
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [],
  };
}

/**
 * A runtime whose graph is inert: resuming must land the screen on the
 * execution-request gate without running anything, which is exactly the
 * state the real flow is in after an approval is recorded.
 */
function inertRuntime(run: TestRunState): NovaRuntime {
  return {
    config: { databasePath: "/tmp/nova-test/nova.sqlite" },
    repository: { get: () => run, save: () => undefined },
    graph: { invoke: async ({ run: current }: { run: TestRunState }) => ({ run: current }) },
  } as unknown as NovaRuntime;
}

async function settle(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

describe("TestFlowScreen execution hand-off", () => {
  it("hands the live screen an executor instead of a run it has already finished", async () => {
    const run = approvedRun();
    let handedRun: TestRunState | undefined;
    let handedExecutor: (() => Promise<unknown>) | undefined;

    const { stdin, lastFrame, unmount } = render(
      <TestFlowScreen
        runtime={inertRuntime(run)}
        resumeRun={run}
        reviewer="qa-lead"
        onExecute={(executeRun, executor) => {
          handedRun = executeRun;
          handedExecutor = executor;
        }}
        onCancel={() => undefined}
      />,
    );

    await settle(150);
    expect(lastFrame() ?? "").toContain("TEST PLAN APPROVED");

    // Buffered keystroke, before the gate has settled: must be ignored.
    stdin.write("\r");
    await settle(30);
    expect(handedExecutor).toBeUndefined();

    // A real keypress, after the guard window: hands over the work.
    await settle(300);
    stdin.write("\r");
    await settle(50);

    expect(handedRun?.runId).toBe(run.runId);
    expect(typeof handedExecutor).toBe("function");
    // Crucially, nothing ran here — the live screen owns the execution.
    expect(run.executionResults).toHaveLength(0);
    unmount();
  });
});
