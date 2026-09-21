import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NovaConfig } from "../src/config/index.js";
import type { NovaRuntime } from "../src/cli/context.js";
import { runDiscover } from "../src/cli/commands.js";
import { runDiscoverWizard } from "../src/cli/interactive/discover-wizard.js";
import { SqliteRunRepository } from "../src/services/persistence/run-repository.js";
import { SqliteApplicationTestMapRepository } from "../src/services/persistence/test-map-repository.js";
import { buildNovaGraph } from "../src/workflow/graph.js";
import type { DiscoverDependencies } from "../src/workflow/nodes/discover.js";
import { mockPromptIO } from "./support/mock-prompt-io.js";
import { createPromptSession } from "../src/cli/interactive/prompt-io.js";

const BASE_URL = "https://shop.example.test/";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-discover-wizard-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function buildTestRuntime(): NovaRuntime {
  const repository = new SqliteRunRepository(join(tempDir, `runs-${randomUUID()}.sqlite`));
  const testMaps = new SqliteApplicationTestMapRepository(join(tempDir, `maps-${randomUUID()}.sqlite`));
  const discover: DiscoverDependencies["discover"] = async ({ runId }) => ({
    runId,
    targetUrl: BASE_URL,
    visitedUrls: [BASE_URL],
    pages: [{ url: BASE_URL, title: "Demo Shop", forms: [], buttons: [], links: [], consoleErrors: [] }],
    apiEndpoints: [],
    capturedAt: new Date().toISOString(),
  });
  const graph = buildNovaGraph({
    discover: { discover },
    execute: {
      executeTestCase: async ({ testCase }) => ({
        caseId: testCase.id,
        attempts: 1,
        stepResults: testCase.steps.map((_step, stepIndex) => ({
          stepIndex,
          status: "passed" as const,
          durationMs: 1,
        })),
        assertionResults: testCase.assertions.map((assertion) => ({
          kind: assertion.kind,
          expected: assertion.expected,
          passed: true,
          observed: assertion.expected,
        })),
        recoveryAttempts: [],
        screenshots: [],
        consoleLogs: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
      artifactsDirectory: tempDir,
      secretResolver: { resolve: () => undefined },
    },
    report: { artifactsDirectory: tempDir },
    checkpointDatabasePath: ":memory:",
  });
  const config: NovaConfig = {
    databasePath: join(tempDir, "runs.sqlite"),
    artifactsDirectory: tempDir,
    headless: true,
  };
  return { config, repository, testMaps, graph };
}

describe("runDiscoverWizard — guided continuation right after `nova discover`", () => {
  it("declining the first prompt leaves the run at 'planning' (unstarted), same as never calling the wizard", async () => {
    const runtime = buildTestRuntime();
    const discovered = await runDiscover(runtime, { target: BASE_URL });

    const { io } = mockPromptIO(["2"]); // confirm -> Cancel
    const session = createPromptSession(io);
    const result = await runDiscoverWizard(runtime, session, discovered);
    session.close();

    expect(result).toEqual({ proceeded: false });
    expect(runtime.repository.get(discovered.runId)?.status).toBe("planning");
  });

  it("an empty objective answer (Ctrl+C/EOF) stops the wizard without planning", async () => {
    const runtime = buildTestRuntime();
    const discovered = await runDiscover(runtime, { target: BASE_URL });

    const { io } = mockPromptIO(["1"]); // confirm -> Yes, then stream ends before an objective is given
    const session = createPromptSession(io);
    const result = await runDiscoverWizard(runtime, session, discovered);
    session.close();

    expect(result).toEqual({ proceeded: false });
    expect(runtime.repository.get(discovered.runId)?.testPlan).toBeUndefined();
  });

  it("walks all the way through plan -> approve -> run -> report on an end-to-end 'yes' each time", async () => {
    const runtime = buildTestRuntime();
    const discovered = await runDiscover(runtime, { target: BASE_URL });

    const { io } = mockPromptIO([
      "1", // continue? -> Yes
      "Confirm the storefront still loads", // objective
      "1", // approve and run now? -> Yes
      "", // reviewer -> accept default
    ]);
    const session = createPromptSession(io);
    const result = await runDiscoverWizard(runtime, session, discovered);
    session.close();

    if (!result.proceeded) {
      throw new Error("expected the wizard to proceed");
    }
    expect(result.plan.cases.length).toBeGreaterThan(0);
    expect(result.approval?.decision).toBe("approved");
    expect(result.execution?.status).toBe("completed");
    expect(result.report?.htmlPath).toBeDefined();

    const finalRun = runtime.repository.get(discovered.runId);
    expect(finalRun?.status).toBe("completed");
    expect(finalRun?.verificationResults.length).toBeGreaterThan(0);
  });

  it("stops after planning when the operator declines to approve+run yet", async () => {
    const runtime = buildTestRuntime();
    const discovered = await runDiscover(runtime, { target: BASE_URL });

    const { io } = mockPromptIO([
      "1", // continue? -> Yes
      "Confirm the storefront still loads", // objective
      "2", // approve and run now? -> Cancel
    ]);
    const session = createPromptSession(io);
    const result = await runDiscoverWizard(runtime, session, discovered);
    session.close();

    if (!result.proceeded) {
      throw new Error("expected the wizard to proceed to planning");
    }
    expect(result.plan.cases.length).toBeGreaterThan(0);
    expect(result.approval).toBeUndefined();

    const finalRun = runtime.repository.get(discovered.runId);
    expect(finalRun?.status).toBe("awaiting_approval");
  });
});
