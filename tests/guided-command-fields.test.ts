import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationTestMap, TestRunState, UserJourney } from "../src/domain/index.js";
import type { NovaConfig } from "../src/config/index.js";
import type { NovaRuntime } from "../src/cli/context.js";
import { SqliteRunRepository } from "../src/services/persistence/run-repository.js";
import { SqliteApplicationTestMapRepository } from "../src/services/persistence/test-map-repository.js";
import { buildNovaGraph } from "../src/workflow/graph.js";
import type { DiscoverDependencies } from "../src/workflow/nodes/discover.js";
import {
  resolveInputs,
  NonInteractiveInputError,
  CancelledInputError,
} from "../src/cli/interactive/resolve-inputs.js";
import {
  JourneyApproveInputSchema,
  buildJourneyApproveFields,
  journeyApproveResolveConfig,
} from "../src/cli/interactive/commands/journey-approve.js";
import {
  JourneyRunInputSchema,
  buildJourneyRunFields,
  journeyRunResolveConfig,
} from "../src/cli/interactive/commands/journey-run.js";
import {
  ReportInputSchema,
  buildReportFields,
  reportResolveConfig,
} from "../src/cli/interactive/commands/report.js";
import { mockPromptIO } from "./support/mock-prompt-io.js";

const DOMAIN = "shop.example.test";
const BASE_URL = `https://${DOMAIN}`;

function baseJourney(overrides: Partial<UserJourney> = {}): UserJourney {
  return {
    id: "journey-1",
    areaId: "area-1",
    name: "Checkout journey",
    description: "A test journey.",
    mode: "quick_test",
    requiredPersonaIds: [],
    requiredFixtureIds: [],
    checkpoints: [
      {
        id: "checkpoint-1",
        name: "Checkpoint",
        expectedOutcome: "The page loads.",
        riskLevel: "low",
        requiresApproval: false,
        evidenceRequirements: ["screenshot"],
        steps: [{ kind: "navigate", url: `${BASE_URL}/`, timeoutMs: 10_000 }],
        assertions: [{ kind: "urlContains", expected: DOMAIN }],
      },
    ],
    allowedRecoveryActions: [],
    status: "approved",
    ...overrides,
  };
}

function baseMap(overrides: Partial<ApplicationTestMap> = {}): ApplicationTestMap {
  const now = new Date().toISOString();
  return {
    id: "map-1",
    version: "1.0.0",
    applicationName: "Shop",
    targetUrl: BASE_URL,
    environment: "staging",
    approvedScope: {
      allowedDomains: [DOMAIN],
      allowedApiHosts: [],
      allowedMethods: ["GET", "POST"],
      executionMode: "safe_test",
    },
    areas: [{ id: "area-1", name: "Checkout", riskLevel: "medium", journeys: [baseJourney()] }],
    personas: [],
    fixtures: [],
    knownConstraints: [],
    status: "accepted",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-guided-fields-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function buildTestRuntime(): NovaRuntime {
  const repository = new SqliteRunRepository(join(tempDir, `runs-${randomUUID()}.sqlite`));
  const testMaps = new SqliteApplicationTestMapRepository(join(tempDir, `maps-${randomUUID()}.sqlite`));
  const discover: DiscoverDependencies["discover"] = async ({ runId }) => ({
    runId,
    targetUrl: `${BASE_URL}/`,
    visitedUrls: [`${BASE_URL}/`],
    pages: [],
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

const NON_INTERACTIVE = { promptingAllowed: false, forceReview: false } as const;

describe("buildJourneyRunFields / nova journey run", () => {
  it("throws immediately when no application test map exists", () => {
    const runtime = buildTestRuntime();
    expect(() => buildJourneyRunFields(runtime)).toThrow(/No application test maps exist/);
  });

  it("resolves directly with zero prompts when map/journeyId/env are all supplied", async () => {
    const runtime = buildTestRuntime();
    runtime.testMaps.save(baseMap());
    const fields = buildJourneyRunFields(runtime);
    const resolved = await resolveInputs(
      journeyRunResolveConfig(fields),
      { map: "map-1", journeyId: "journey-1", env: "staging" },
      { promptingAllowed: true, forceReview: false },
    );
    const input = JourneyRunInputSchema.parse(resolved);
    expect(input).toEqual({ map: "map-1", journeyId: "journey-1", env: "staging" });
  });

  it("guided mode picks the most recently updated map and derives env from it", async () => {
    const runtime = buildTestRuntime();
    runtime.testMaps.save(baseMap({ id: "map-old", updatedAt: "2024-01-01T00:00:00.000Z" }));
    runtime.testMaps.save(baseMap({ id: "map-new", updatedAt: "2024-06-01T00:00:00.000Z" }));
    const fields = buildJourneyRunFields(runtime);
    const { io } = mockPromptIO([
      "", // map -> accept default (most recently updated: map-new)
      "1", // journey -> only one approved journey
      "", // env -> accept the map's own environment
      "yes",
    ]);
    const resolved = await resolveInputs(
      journeyRunResolveConfig(fields),
      {},
      { promptingAllowed: true, forceReview: false },
      io,
    );
    expect(resolved.map).toBe("map-new");
    expect(resolved.env).toBe("staging");
  });

  it("non-interactive mode derives env from an explicitly supplied map (deterministic, not a guess)", async () => {
    const runtime = buildTestRuntime();
    runtime.testMaps.save(baseMap());
    const fields = buildJourneyRunFields(runtime);
    const resolved = await resolveInputs(
      journeyRunResolveConfig(fields),
      { map: "map-1", journeyId: "journey-1" },
      NON_INTERACTIVE,
    );
    expect(resolved.env).toBe("staging");
  });

  it("non-interactive mode reports every missing input at once", async () => {
    const runtime = buildTestRuntime();
    runtime.testMaps.save(baseMap());
    const fields = buildJourneyRunFields(runtime);
    await expect(resolveInputs(journeyRunResolveConfig(fields), {}, NON_INTERACTIVE)).rejects.toThrow(
      NonInteractiveInputError,
    );
  });

  it("errors clearly when the chosen map has no approved journeys to run", async () => {
    const runtime = buildTestRuntime();
    runtime.testMaps.save(
      baseMap({
        areas: [
          {
            id: "area-1",
            name: "Checkout",
            riskLevel: "medium",
            journeys: [baseJourney({ status: "draft" })],
          },
        ],
      }),
    );
    const fields = buildJourneyRunFields(runtime);
    const { io } = mockPromptIO(["", "1"]);
    await expect(
      resolveInputs(journeyRunResolveConfig(fields), {}, { promptingAllowed: true, forceReview: false }, io),
    ).rejects.toThrow(/No approved journeys/);
  });
});

describe("buildJourneyApproveFields / nova journey approve", () => {
  it("throws immediately when no application test map exists", () => {
    const runtime = buildTestRuntime();
    expect(() => buildJourneyApproveFields(runtime)).toThrow(/No application test maps exist/);
  });

  it("resolves directly with zero prompts when map and journeyId are both supplied", async () => {
    const runtime = buildTestRuntime();
    runtime.testMaps.save(
      baseMap({
        areas: [
          {
            id: "area-1",
            name: "Checkout",
            riskLevel: "medium",
            journeys: [baseJourney({ status: "draft" })],
          },
        ],
      }),
    );
    const fields = buildJourneyApproveFields(runtime);
    const resolved = await resolveInputs(
      journeyApproveResolveConfig(fields),
      { map: "map-1", journeyId: "journey-1" },
      { promptingAllowed: true, forceReview: false },
    );
    expect(JourneyApproveInputSchema.parse(resolved)).toEqual({ map: "map-1", journeyId: "journey-1" });
  });

  it("guided mode only offers draft journeys for approval", async () => {
    const runtime = buildTestRuntime();
    runtime.testMaps.save(
      baseMap({
        areas: [
          {
            id: "area-1",
            name: "Checkout",
            riskLevel: "medium",
            journeys: [
              baseJourney({ id: "already-approved", status: "approved" }),
              baseJourney({ id: "needs-approval", status: "draft" }),
            ],
          },
        ],
      }),
    );
    const fields = buildJourneyApproveFields(runtime);
    const { io, transcript } = mockPromptIO(["", "1", "1"]);
    const resolved = await resolveInputs(
      journeyApproveResolveConfig(fields),
      {},
      { promptingAllowed: true, forceReview: false },
      io,
    );
    expect(resolved.journeyId).toBe("needs-approval");
    expect(transcript()).not.toContain("already-approved");
  });

  it("errors clearly when nothing in the map needs approval", async () => {
    const runtime = buildTestRuntime();
    runtime.testMaps.save(baseMap()); // journey is already "approved"
    const fields = buildJourneyApproveFields(runtime);
    const { io } = mockPromptIO([""]);
    await expect(
      resolveInputs(
        journeyApproveResolveConfig(fields),
        {},
        { promptingAllowed: true, forceReview: false },
        io,
      ),
    ).rejects.toThrow(/No draft journeys need approval/);
  });
});

function makeRun(overrides: Partial<TestRunState> = {}): TestRunState {
  return {
    tenantId: "default",
    projectId: "default",
    runId: randomUUID(),
    targetManifest: {
      targetId: "demo-app",
      baseUrl: BASE_URL,
      allowedDomains: [DOMAIN],
      environment: "staging",
      description: "",
      runExecutionMode: "safe_test",
      createdAt: new Date().toISOString(),
    },
    status: "completed",
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [],
    ...overrides,
  };
}

describe("buildReportFields / nova report", () => {
  it("throws immediately when there are no runs to report on", () => {
    const runtime = buildTestRuntime();
    expect(() => buildReportFields(runtime)).toThrow(/No runs found/);
  });

  it("resolves directly with zero prompts when --run is already supplied", async () => {
    const runtime = buildTestRuntime();
    const run = makeRun();
    runtime.repository.save(run);
    const fields = buildReportFields(runtime);
    const resolved = await resolveInputs(
      reportResolveConfig(fields),
      { run: run.runId },
      { promptingAllowed: true, forceReview: false },
    );
    expect(ReportInputSchema.parse(resolved)).toEqual({ run: run.runId });
  });

  it("guided mode lets an operator pick from every existing run", async () => {
    const runtime = buildTestRuntime();
    const runA = makeRun();
    const runB = makeRun();
    runtime.repository.save(runA);
    runtime.repository.save(runB);
    const fields = buildReportFields(runtime);
    const { io } = mockPromptIO(["2", "yes"]);
    const resolved = await resolveInputs(
      reportResolveConfig(fields),
      {},
      { promptingAllowed: true, forceReview: false },
      io,
    );
    expect([runA.runId, runB.runId]).toContain(resolved.run);
  });

  it("cancels cleanly when the operator declines the final confirmation", async () => {
    const runtime = buildTestRuntime();
    runtime.repository.save(makeRun());
    const fields = buildReportFields(runtime);
    const { io } = mockPromptIO(["1", "cancel"]);
    await expect(
      resolveInputs(reportResolveConfig(fields), {}, { promptingAllowed: true, forceReview: false }, io),
    ).rejects.toThrow(CancelledInputError);
  });

  it("non-interactive mode never guesses which run to report on", async () => {
    const runtime = buildTestRuntime();
    runtime.repository.save(makeRun());
    const fields = buildReportFields(runtime);
    await expect(resolveInputs(reportResolveConfig(fields), {}, NON_INTERACTIVE)).rejects.toThrow(
      NonInteractiveInputError,
    );
  });
});
