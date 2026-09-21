import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

import { buildRuntime, type NovaRuntime } from "../../src/cli/context.js";
import { runExecution } from "../../src/cli/commands.js";
import type { TargetManifest, TestPlan, TestRunState } from "../../src/domain/index.js";
import { LiveExecutionScreen } from "../../src/tui/screens/LiveExecutionScreen.js";

// Proves the TUI's LiveExecutionScreen cannot bypass Nova's approval
// gate: it calls the exact same `runExecution` (src/cli/commands.ts)
// the CLI's `nova run`/`nova journey confirm` path calls, which refuses
// any run whose status is not "approved" — verified here against a real
// runtime (real sqlite-backed run repository), not a mock, so the
// refusal is the real enforced behavior, not a stand-in for it.

const manifest: TargetManifest = {
  targetId: "demo-app",
  baseUrl: "https://shop.example.test/",
  allowedDomains: ["shop.example.test"],
  environment: "local",
  description: "",
  runExecutionMode: "safe_test",
  createdAt: new Date().toISOString(),
};

const testPlan: TestPlan = {
  id: randomUUID(),
  version: 1,
  objective: "Confirm the storefront loads",
  targetManifestId: manifest.targetId,
  createdAt: new Date().toISOString(),
  cases: [
    {
      id: "case-1",
      title: "Storefront loads",
      preconditions: [],
      steps: [{ kind: "navigate", url: manifest.baseUrl, timeoutMs: 10_000 }],
      assertions: [{ kind: "titleContains", expected: "Demo Shop" }],
      allowedDomains: manifest.allowedDomains,
      executionMode: "read_only",
      riskLevel: "low",
      timeoutMs: 60_000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      recoveryBudget: 0,
    },
  ],
};

function unapprovedRun(): TestRunState {
  return {
    tenantId: "default",
    projectId: "default",
    runId: randomUUID(),
    targetManifest: manifest,
    objective: testPlan.objective,
    testPlan,
    status: "awaiting_approval",
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [],
  };
}

const noop = (): void => {
  // intentionally empty — these tests only assert on the refusal.
};

let tempDir: string;
let runtime: NovaRuntime;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-live-execution-policy-test-"));
  runtime = buildRuntime({
    databasePath: join(tempDir, "nova.sqlite"),
    artifactsDirectory: join(tempDir, "artifacts"),
    headless: true,
  });
});

afterEach(() => {
  runtime.repository.close();
  runtime.testMaps.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("a TUI action cannot execute an unapproved run", () => {
  it("runExecution (src/cli/commands.ts) itself refuses a non-approved run — the CLI's own enforcement", async () => {
    const run = unapprovedRun();
    runtime.repository.save(run);

    await expect(runExecution(runtime, { plan: run.runId })).rejects.toThrow(
      `Run ${run.runId} is "awaiting_approval"; only an approved plan can be executed.`,
    );
  });

  it("LiveExecutionScreen (no executor override, so it calls the real runExecution) refuses the identical unapproved run the same way the CLI does", async () => {
    const run = unapprovedRun();
    runtime.repository.save(run);

    const { lastFrame, unmount } = render(
      <LiveExecutionScreen
        runtime={runtime}
        run={run}
        verbosity="standard"
        paused={false}
        onTogglePause={noop}
        onComplete={noop}
        onStop={noop}
        onCycleVerbosity={noop}
        onOpenCommandMode={noop}
      />,
    );

    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 500);
    await promise;

    // The box border wraps long lines at the render width, re-drawing a
    // "│" border on each wrapped visual line — strip border chars and
    // collapse whitespace before checking for the (otherwise contiguous)
    // message.
    const frame = (lastFrame() ?? "").replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
    expect(frame).toContain(
      `Execution error: Run ${run.runId} is "awaiting_approval"; only an approved plan can be executed.`,
    );
    // The run was never mutated into an executing/passed/failed state —
    // the refusal happened before any browser step ran.
    expect(runtime.repository.get(run.runId)?.status).toBe("awaiting_approval");

    unmount();
  });
});
