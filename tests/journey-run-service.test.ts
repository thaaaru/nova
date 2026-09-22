import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationTestMap, TestDataFixture, UserJourney } from "../src/domain/index.js";
import type { NovaConfig } from "../src/config/index.js";
import type { NovaRuntime } from "../src/cli/context.js";
import { SqliteRunRepository } from "../src/services/persistence/run-repository.js";
import { SqliteApplicationTestMapRepository } from "../src/services/persistence/test-map-repository.js";
import { SqliteProjectRepository } from "../src/services/persistence/project-repository.js";
import { SqlitePersonaRepository } from "../src/services/persistence/persona-repository.js";
import { buildNovaGraph } from "../src/workflow/graph.js";
import type { ExecuteDependencies } from "../src/workflow/nodes/execute.js";
import type { JourneyRunContext } from "../src/services/testmap/map-to-plan.js";
import {
  JourneyScopeError,
  confirmJourneyRun,
  startJourneyRun,
  validateJourneyRunContext,
} from "../src/services/testmap/journey-run-service.js";

const DOMAIN = "shop.example.test";
const BASE_URL = `https://${DOMAIN}`;

function baseMap(overrides: Partial<ApplicationTestMap> = {}): ApplicationTestMap {
  const now = new Date().toISOString();
  return {
    id: "map-1",
    version: "1.0.0",
    applicationName: "Test App",
    targetUrl: BASE_URL,
    environment: "staging",
    approvedScope: {
      allowedDomains: [DOMAIN],
      allowedApiHosts: [],
      allowedMethods: ["GET", "POST"],
      executionMode: "safe_test",
    },
    areas: [],
    personas: [
      {
        id: "persona-a",
        name: "Persona A",
        description: "A test persona.",
        credentialReferenceId: "cred-a",
        permissions: [],
        allowedEnvironments: ["staging"],
      },
    ],
    fixtures: [
      {
        id: "fixture-a",
        name: "Fixture A",
        description: "A test fixture.",
        dataReferenceId: "data-a",
        lockRequired: false,
      },
    ],
    knownConstraints: [],
    status: "accepted",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseJourney(overrides: Partial<UserJourney> = {}): UserJourney {
  return {
    id: "journey-1",
    areaId: "area-1",
    name: "Journey",
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

function mapWithJourney(
  journey: UserJourney,
  mapOverrides: Partial<ApplicationTestMap> = {},
): ApplicationTestMap {
  return baseMap({
    areas: [{ id: journey.areaId, name: "Area", riskLevel: "low", journeys: [journey] }],
    ...mapOverrides,
  });
}

describe("validateJourneyRunContext", () => {
  it("throws when the journey is not approved", () => {
    const journey = baseJourney({ status: "draft" });
    const map = baseMap();
    const context: JourneyRunContext = { environment: "staging", fixtureIds: [] };
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(JourneyScopeError);
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(/"draft"/);
  });

  it("throws when the requested environment does not match the map's environment", () => {
    const journey = baseJourney();
    const map = baseMap({ environment: "staging" });
    const context: JourneyRunContext = { environment: "production", fixtureIds: [] };
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(JourneyScopeError);
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(/environment/);
  });

  it("throws when a required persona is missing from the request", () => {
    const journey = baseJourney({ requiredPersonaIds: ["persona-a"] });
    const map = baseMap();
    const context: JourneyRunContext = { environment: "staging", fixtureIds: [] };
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(JourneyScopeError);
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(/persona/);
  });

  it("throws when the given persona is not permitted in the requested environment", () => {
    const journey = baseJourney({ requiredPersonaIds: ["persona-a"] });
    const map = baseMap({ environment: "production" });
    const context: JourneyRunContext = { environment: "production", personaId: "persona-a", fixtureIds: [] };
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(JourneyScopeError);
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(/not permitted in environment/);
  });

  it("throws when a required fixture is missing from the request", () => {
    const journey = baseJourney({ requiredFixtureIds: ["fixture-a"] });
    const map = baseMap();
    const context: JourneyRunContext = { environment: "staging", fixtureIds: [] };
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(JourneyScopeError);
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(/requires fixture/);
  });

  it("throws for an unknown fixture id", () => {
    const journey = baseJourney();
    const map = baseMap();
    const context: JourneyRunContext = { environment: "staging", fixtureIds: ["unknown-fixture"] };
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(JourneyScopeError);
    expect(() => validateJourneyRunContext(map, journey, context)).toThrow(/Unknown fixture/);
  });

  it("does not throw for a fully valid context", () => {
    const journey = baseJourney({ requiredPersonaIds: ["persona-a"], requiredFixtureIds: ["fixture-a"] });
    const map = baseMap();
    const context: JourneyRunContext = {
      environment: "staging",
      personaId: "persona-a",
      fixtureIds: ["fixture-a"],
    };
    expect(() => validateJourneyRunContext(map, journey, context)).not.toThrow();
  });
});

const passingExecute: ExecuteDependencies["executeTestCase"] = async ({ testCase }) => ({
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
});

const failingExecute: ExecuteDependencies["executeTestCase"] = async ({ testCase }) => ({
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
    passed: false,
    observed: "unexpected-value",
  })),
  recoveryAttempts: [],
  screenshots: [],
  consoleLogs: [],
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
});

let tempDir: string;

function buildTestRuntime(executeTestCase: ExecuteDependencies["executeTestCase"]): NovaRuntime {
  const repository = new SqliteRunRepository(join(tempDir, `runs-${randomUUID()}.sqlite`));
  const testMaps = new SqliteApplicationTestMapRepository(join(tempDir, `maps-${randomUUID()}.sqlite`));
  const projects = new SqliteProjectRepository(join(tempDir, `projects-${randomUUID()}.sqlite`));
  const personas = new SqlitePersonaRepository(join(tempDir, `personas-${randomUUID()}.sqlite`));
  const sessionVaultDir = join(tempDir, "session-vault");
  const graph = buildNovaGraph({
    discover: {
      discover: async ({ runId }) => ({
        runId,
        targetUrl: `${BASE_URL}/`,
        visitedUrls: [`${BASE_URL}/`],
        pages: [],
        apiEndpoints: [],
        capturedAt: new Date().toISOString(),
      }),
    },
    execute: { executeTestCase, secretResolver: { resolve: () => undefined }, artifactsDirectory: tempDir },
    report: { artifactsDirectory: tempDir },
    checkpointDatabasePath: ":memory:",
  });
  const config: NovaConfig = {
    databasePath: join(tempDir, "runs.sqlite"),
    artifactsDirectory: tempDir,
    headless: true,
  };
  return { config, repository, testMaps, projects, personas, sessionVaultDir, graph };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-journey-run-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("startJourneyRun scope enforcement", () => {
  it("rejects a run outside the map's approved environment even when called directly", async () => {
    const runtime = buildTestRuntime(passingExecute);
    const journey = baseJourney({ status: "approved" });
    const map = mapWithJourney(journey, { environment: "staging" });
    runtime.testMaps.save(map);

    const context: JourneyRunContext = { environment: "production", fixtureIds: [] };
    await expect(startJourneyRun(runtime, runtime.testMaps, map, journey, context)).rejects.toThrow(
      JourneyScopeError,
    );
  });

  it("rejects an unapproved (draft) journey even when called directly", async () => {
    const runtime = buildTestRuntime(passingExecute);
    const journey = baseJourney({ status: "draft" });
    const map = mapWithJourney(journey);
    runtime.testMaps.save(map);

    const context: JourneyRunContext = { environment: "staging", fixtureIds: [] };
    await expect(startJourneyRun(runtime, runtime.testMaps, map, journey, context)).rejects.toThrow(
      JourneyScopeError,
    );
  });
});

describe("startJourneyRun mode routing", () => {
  it("executes a quick_test journey immediately, with no separate confirm call", async () => {
    const runtime = buildTestRuntime(passingExecute);
    const journey = baseJourney({ mode: "quick_test", status: "approved" });
    const map = mapWithJourney(journey);
    runtime.testMaps.save(map);

    const context: JourneyRunContext = { environment: "staging", fixtureIds: [] };
    const prepared = await startJourneyRun(runtime, runtime.testMaps, map, journey, context);

    expect(prepared.status).not.toBe("awaiting_approval");
    expect(["executing", "completed", "failed"]).toContain(prepared.status);

    const savedMap = runtime.testMaps.get(map.id);
    expect(savedMap?.areas[0]?.journeys[0]?.lastRunOutcome).toBeDefined();
  });

  it.each(["guided_test", "controlled_test"] as const)(
    "stages a %s journey for approval and requires a separate confirmJourneyRun call to proceed",
    async (mode) => {
      const runtime = buildTestRuntime(passingExecute);
      const journey = baseJourney({ mode, status: "approved" });
      const map = mapWithJourney(journey);
      runtime.testMaps.save(map);

      const context: JourneyRunContext = { environment: "staging", fixtureIds: [] };
      const prepared = await startJourneyRun(runtime, runtime.testMaps, map, journey, context);
      expect(prepared.status).toBe("awaiting_approval");

      const stillWaiting = runtime.repository.get(prepared.runId);
      expect(stillWaiting?.status).toBe("awaiting_approval");

      const confirmed = await confirmJourneyRun(runtime, runtime.testMaps, prepared.runId, "qa-lead");
      expect(["completed", "failed"]).toContain(confirmed.status);
    },
  );
});

describe("runJourneyCleanup (via confirmJourneyRun)", () => {
  it("releases fixture locks and records a fixture_cleanup_recorded audit event even when the run fails", async () => {
    const runtime = buildTestRuntime(failingExecute);
    const lockedFixture: TestDataFixture = {
      id: "locked-fixture",
      name: "Locked Fixture",
      description: "A fixture that must be locked for the run's duration.",
      cleanupAction: "Release the locked fixture back to the pool.",
      dataReferenceId: "data-locked",
      lockRequired: true,
    };
    const journey = baseJourney({
      mode: "guided_test",
      status: "approved",
      requiredFixtureIds: ["locked-fixture"],
    });
    const map = mapWithJourney(journey, { fixtures: [lockedFixture] });
    runtime.testMaps.save(map);

    const context: JourneyRunContext = { environment: "staging", fixtureIds: ["locked-fixture"] };
    const prepared = await startJourneyRun(runtime, runtime.testMaps, map, journey, context);
    expect(runtime.testMaps.isFixtureLocked(map.id, "locked-fixture")).toBe(true);

    const result = await confirmJourneyRun(runtime, runtime.testMaps, prepared.runId, "qa-lead");
    expect(result.status).toBe("failed");

    expect(runtime.testMaps.isFixtureLocked(map.id, "locked-fixture")).toBe(false);

    const finalRun = runtime.repository.get(prepared.runId);
    expect(
      finalRun?.auditEvents.some(
        (event) => event.type === "fixture_cleanup_recorded" && event.detail?.fixtureId === "locked-fixture",
      ),
    ).toBe(true);
  });
});
