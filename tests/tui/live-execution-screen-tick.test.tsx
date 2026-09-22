import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

import { buildRuntime, type NovaRuntime } from "../../src/cli/context.js";
import type { TargetManifest, TestPlan, TestRunState } from "../../src/domain/index.js";
import { LiveExecutionScreen } from "../../src/tui/screens/LiveExecutionScreen.js";

// Regression for a real bug report: a paused (or stuck-on-a-hung-executor)
// run's 900ms tick timer kept calling setElapsedMs unconditionally, so
// Ink re-rendered the whole frame every ~900ms even while nothing was
// actually progressing — visible to the user as the terminal "clearing"
// once a second indefinitely. The tick body must be a no-op (no setState
// at all) whenever the run is paused or stopped.

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
    {
      id: "case-2",
      title: "Cart is empty by default",
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

function approvedRun(): TestRunState {
  return {
    tenantId: "default",
    projectId: "default",
    runId: randomUUID(),
    targetManifest: manifest,
    objective: testPlan.objective,
    testPlan,
    status: "approved",
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [],
  };
}

const noop = (): void => {
  // intentionally empty for props this test does not exercise.
};

let tempDir: string;
let runtime: NovaRuntime;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-live-exec-tick-"));
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

describe("LiveExecutionScreen tick loop", () => {
  it("does not re-render the frame while paused, even with a hung executor", async () => {
    vi.useFakeTimers();
    try {
      const run = approvedRun();
      // An executor promise that never resolves — models the reported
      // "stuck open for an hour" hang. If the tick body still touched
      // setState unconditionally, the frame would keep changing forever.
      const hungExecutor = (): Promise<never> => new Promise(() => {});

      const { lastFrame } = render(
        <LiveExecutionScreen
          runtime={runtime}
          run={run}
          verbosity="standard"
          animationEnabled={false}
          paused={true}
          onTogglePause={noop}
          onComplete={noop}
          onStop={noop}
          onCycleVerbosity={noop}
          onOpenCommandMode={noop}
          executor={hungExecutor}
        />,
      );

      await vi.advanceTimersByTimeAsync(1);
      const frameBefore = lastFrame();

      // Advance past several tick intervals (900ms each).
      await vi.advanceTimersByTimeAsync(900 * 5);
      const frameAfter = lastFrame();

      expect(frameAfter).toBe(frameBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes ticking once unpaused", async () => {
    vi.useFakeTimers();
    try {
      const run = approvedRun();
      const hungExecutor = (): Promise<never> => new Promise(() => {});

      let paused = true;
      const { lastFrame, rerender } = render(
        <LiveExecutionScreen
          runtime={runtime}
          run={run}
          verbosity="standard"
          animationEnabled={false}
          paused={paused}
          onTogglePause={noop}
          onComplete={noop}
          onStop={noop}
          onCycleVerbosity={noop}
          onOpenCommandMode={noop}
          executor={hungExecutor}
        />,
      );

      await vi.advanceTimersByTimeAsync(900 * 3);
      const framePaused = lastFrame();

      paused = false;
      rerender(
        <LiveExecutionScreen
          runtime={runtime}
          run={run}
          verbosity="standard"
          animationEnabled={false}
          paused={paused}
          onTogglePause={noop}
          onComplete={noop}
          onStop={noop}
          onCycleVerbosity={noop}
          onOpenCommandMode={noop}
          executor={hungExecutor}
        />,
      );

      await vi.advanceTimersByTimeAsync(900 * 3);
      const frameRunning = lastFrame();

      expect(frameRunning).not.toBe(framePaused);
    } finally {
      vi.useRealTimers();
    }
  });
});
