import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationTestMap, RecoveryAttempt, UserJourney } from "../src/domain/index.js";
import type { NovaConfig } from "../src/config/index.js";
import type { NovaRuntime } from "../src/cli/context.js";
import { SqliteRunRepository } from "../src/services/persistence/run-repository.js";
import { SqliteApplicationTestMapRepository } from "../src/services/persistence/test-map-repository.js";
import { buildNovaGraph } from "../src/workflow/graph.js";
import { executeTestCase } from "../src/services/browser/execute.js";
import { startJourneyRun } from "../src/services/testmap/journey-run-service.js";
import {
  applySelectorHeals,
  deriveHealCandidates,
  locateCheckpointStep,
} from "../src/services/testmap/selector-healing.js";

function journey(overrides: Partial<UserJourney> = {}): UserJourney {
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
        evidenceRequirements: [],
        steps: [{ kind: "navigate", url: "https://example.com/", timeoutMs: 10_000 }],
        assertions: [{ kind: "urlContains", expected: "example.com" }],
      },
    ],
    allowedRecoveryActions: [],
    status: "approved",
    ...overrides,
  };
}

describe("locateCheckpointStep", () => {
  it("maps a flattened TestCase step index back to the checkpoint and in-checkpoint index it came from", () => {
    const twoCheckpointJourney = journey({
      checkpoints: [
        {
          id: "checkpoint-a",
          name: "A",
          expectedOutcome: "ok",
          riskLevel: "low",
          requiresApproval: false,
          evidenceRequirements: [],
          steps: [
            { kind: "navigate", url: "https://example.com/", timeoutMs: 10_000 },
            { kind: "click", selector: "#a", timeoutMs: 10_000 },
          ],
          assertions: [],
        },
        {
          id: "checkpoint-b",
          name: "B",
          expectedOutcome: "ok",
          riskLevel: "low",
          requiresApproval: false,
          evidenceRequirements: [],
          steps: [{ kind: "click", selector: "#b", timeoutMs: 10_000 }],
          assertions: [],
        },
      ],
    });

    expect(locateCheckpointStep(twoCheckpointJourney, 0)).toEqual({
      checkpointId: "checkpoint-a",
      stepIndexInCheckpoint: 0,
    });
    expect(locateCheckpointStep(twoCheckpointJourney, 1)).toEqual({
      checkpointId: "checkpoint-a",
      stepIndexInCheckpoint: 1,
    });
    expect(locateCheckpointStep(twoCheckpointJourney, 2)).toEqual({
      checkpointId: "checkpoint-b",
      stepIndexInCheckpoint: 0,
    });
  });

  it("returns undefined for an index past every checkpoint's steps", () => {
    expect(locateCheckpointStep(journey(), 99)).toBeUndefined();
  });
});

describe("deriveHealCandidates", () => {
  const baseAttempt: RecoveryAttempt = {
    stepIndex: 0,
    checkpoint: "Checkpoint",
    failureSummary: "stale selector",
    evidenceSummary: "resolved via role",
    action: "re-derive",
    attempt: 1,
    maxAttempts: 2,
    outcome: "recovered",
    healedSelector: 'role=button[name="Add to cart"]',
  };

  it("produces a candidate for a recovered attempt that carries a healed selector", () => {
    const candidates = deriveHealCandidates(journey(), [baseAttempt]);
    expect(candidates).toEqual([
      {
        journeyId: "journey-1",
        checkpointId: "checkpoint-1",
        stepIndexInCheckpoint: 0,
        healedSelector: 'role=button[name="Add to cart"]',
      },
    ]);
  });

  it("never produces a candidate for an exhausted attempt", () => {
    const candidates = deriveHealCandidates(journey(), [
      { ...baseAttempt, outcome: "exhausted", healedSelector: undefined },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("never produces a candidate for a recovered attempt with no healed selector recorded", () => {
    const candidates = deriveHealCandidates(journey(), [{ ...baseAttempt, healedSelector: undefined }]);
    expect(candidates).toHaveLength(0);
  });
});

describe("applySelectorHeals", () => {
  function mapWithJourney(theJourney: UserJourney): ApplicationTestMap {
    const now = new Date().toISOString();
    return {
      id: "map-1",
      version: "1.0.0",
      applicationName: "Test App",
      targetUrl: "https://example.com",
      environment: "staging",
      approvedScope: {
        allowedDomains: ["example.com"],
        allowedApiHosts: [],
        allowedMethods: ["GET", "POST"],
        executionMode: "safe_test",
      },
      areas: [{ id: "area-1", name: "Area", riskLevel: "low", journeys: [theJourney] }],
      personas: [],
      fixtures: [],
      knownConstraints: [],
      status: "accepted",
      createdAt: now,
      updatedAt: now,
    };
  }

  it("replaces the target step's selector with the healed one and bumps updatedAt", () => {
    const theJourney = journey({
      checkpoints: [
        {
          id: "checkpoint-1",
          name: "Checkpoint",
          expectedOutcome: "ok",
          riskLevel: "medium",
          requiresApproval: true,
          evidenceRequirements: [],
          steps: [{ kind: "click", selector: "#stale", timeoutMs: 10_000 }],
          assertions: [],
        },
      ],
    });
    const map = mapWithJourney(theJourney);

    const healed = applySelectorHeals(map, [
      {
        journeyId: theJourney.id,
        checkpointId: "checkpoint-1",
        stepIndexInCheckpoint: 0,
        healedSelector: 'role=button[name="Checkout"]',
      },
    ]);

    const healedStep = healed.areas[0]?.journeys[0]?.checkpoints[0]?.steps[0];
    expect(healedStep?.selector).toBe('role=button[name="Checkout"]');
    expect(new Date(healed.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(map.updatedAt).getTime());
    // Every other step field is preserved untouched.
    expect(healedStep?.kind).toBe("click");
    expect(healedStep?.timeoutMs).toBe(10_000);
  });

  it("returns the exact same map reference when there is nothing to heal", () => {
    const map = mapWithJourney(journey());
    expect(applySelectorHeals(map, [])).toBe(map);
  });

  it("returns the exact same map reference when the healed selector already matches — a no-op heal never bumps updatedAt", () => {
    const theJourney = journey({
      checkpoints: [
        {
          id: "checkpoint-1",
          name: "Checkpoint",
          expectedOutcome: "ok",
          riskLevel: "low",
          requiresApproval: false,
          evidenceRequirements: [],
          steps: [{ kind: "click", selector: "role=button", timeoutMs: 10_000 }],
          assertions: [],
        },
      ],
    });
    const map = mapWithJourney(theJourney);

    const healed = applySelectorHeals(map, [
      {
        journeyId: theJourney.id,
        checkpointId: "checkpoint-1",
        stepIndexInCheckpoint: 0,
        healedSelector: "role=button",
      },
    ]);
    expect(healed).toBe(map);
  });

  it("silently drops a candidate naming a journey/checkpoint that no longer exists on the map", () => {
    const map = mapWithJourney(journey());
    const healed = applySelectorHeals(map, [
      {
        journeyId: "no-such-journey",
        checkpointId: "no-such-checkpoint",
        stepIndexInCheckpoint: 0,
        healedSelector: "#anything",
      },
    ]);
    expect(healed).toBe(map);
  });
});

describe("persistent selector healing — real end-to-end run against a live demo app", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const demoAppDir = join(process.cwd(), "fixtures", "demo-app");
    server = createServer((request, response) => {
      const path = request.url === "/" || !request.url ? "/index.html" : request.url;
      try {
        const body = readFileSync(join(demoAppDir, path));
        response.writeHead(200, { "content-type": "text/html" });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end("not found");
      }
    });
    const { promise: listening, resolve: listeningReady } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listeningReady);
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind the demo app test server.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    const { promise: closed, resolve: closedReady } = Promise.withResolvers<void>();
    server.close(() => closedReady());
    await closed;
  });

  let tempDir: string;
  let runtime: NovaRuntime;
  let domain: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nova-selector-heal-test-"));
    domain = new URL(baseUrl).hostname;
    const repository = new SqliteRunRepository(join(tempDir, `runs-${randomUUID()}.sqlite`));
    const testMaps = new SqliteApplicationTestMapRepository(join(tempDir, `maps-${randomUUID()}.sqlite`));
    const graph = buildNovaGraph({
      discover: {
        discover: async ({ runId }) => ({
          runId,
          targetUrl: `${baseUrl}/`,
          visitedUrls: [`${baseUrl}/`],
          pages: [],
          apiEndpoints: [],
          capturedAt: new Date().toISOString(),
        }),
      },
      // The real, non-mocked browser executor — exactly what a live run uses.
      execute: { executeTestCase, secretResolver: { resolve: () => undefined }, artifactsDirectory: tempDir },
      report: { artifactsDirectory: tempDir },
      checkpointDatabasePath: ":memory:",
    });
    const config: NovaConfig = {
      databasePath: join(tempDir, "runs.sqlite"),
      artifactsDirectory: tempDir,
      headless: true,
    };
    runtime = { config, repository, testMaps, graph };
  });

  afterEach(() => {
    runtime.repository.close();
    runtime.testMaps.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildStaleSelectorMap(): { map: ApplicationTestMap; journey: UserJourney } {
    // The demo app's real "Subscribe to newsletter" button has no id —
    // this selector was never valid, standing in for drift (a rename, a
    // rebuilt component) between when the journey was curated and now.
    const staleJourney = journey({
      id: "journey-newsletter",
      mode: "quick_test",
      checkpoints: [
        {
          id: "checkpoint-subscribe",
          name: "Subscribe",
          expectedOutcome: "The newsletter button activates.",
          riskLevel: "medium",
          requiresApproval: false,
          evidenceRequirements: [],
          steps: [
            { kind: "navigate", url: `${baseUrl}/`, timeoutMs: 10_000 },
            {
              kind: "click",
              selector: "#stale-newsletter-button-id",
              role: "button",
              name: "Subscribe to newsletter",
              timeoutMs: 5_000,
            },
          ],
          assertions: [{ kind: "titleContains", expected: "Nova Demo Shop" }],
        },
      ],
      allowedRecoveryActions: ["role_name_match"],
    });

    const now = new Date().toISOString();
    const map: ApplicationTestMap = {
      id: "map-newsletter",
      version: "1.0.0",
      applicationName: "Demo Shop",
      targetUrl: baseUrl,
      environment: "local",
      approvedScope: {
        allowedDomains: [domain],
        allowedApiHosts: [],
        allowedMethods: ["GET", "POST"],
        executionMode: "safe_test",
      },
      areas: [{ id: "area-home", name: "Home", riskLevel: "medium", journeys: [staleJourney] }],
      personas: [],
      fixtures: [],
      knownConstraints: [],
      status: "accepted",
      createdAt: now,
      updatedAt: now,
    };
    return { map, journey: staleJourney };
  }

  it("heals a stale selector after a recovered run, and the second run needs zero recovery attempts", async () => {
    const { map, journey: staleJourney } = buildStaleSelectorMap();
    runtime.testMaps.save(map);

    const context = { environment: "local", fixtureIds: [] };

    // First run: the declared selector is stale, but role+name recovery
    // finds the real button — a real Playwright recovery, not simulated.
    const firstRun = await startJourneyRun(runtime, runtime.testMaps, map, staleJourney, context);
    const firstResult = runtime.repository.get(firstRun.runId);
    expect(firstResult?.status).toBe("completed");
    const firstRecoveryAttempts = (firstResult?.executionResults ?? []).flatMap((r) => r.recoveryAttempts);
    expect(firstRecoveryAttempts.some((attempt) => attempt.outcome === "recovered")).toBe(true);

    // The map on disk must now carry the healed selector.
    const healedMap = runtime.testMaps.get(map.id);
    const healedStep = healedMap?.areas[0]?.journeys[0]?.checkpoints[0]?.steps[1];
    expect(healedStep?.selector).not.toBe("#stale-newsletter-button-id");
    expect(healedStep?.selector).toContain("Subscribe to newsletter");

    // Second run of the same journey, reading the now-healed map — must
    // succeed with zero recovery attempts, proving the map itself
    // learned, not just this one run.
    const healedJourney = healedMap?.areas[0]?.journeys[0];
    expect(healedJourney).toBeDefined();
    const secondRun = await startJourneyRun(
      runtime,
      runtime.testMaps,
      healedMap as ApplicationTestMap,
      healedJourney as UserJourney,
      context,
    );
    const secondResult = runtime.repository.get(secondRun.runId);
    expect(secondResult?.status).toBe("completed");
    const secondRecoveryAttempts = (secondResult?.executionResults ?? []).flatMap((r) => r.recoveryAttempts);
    expect(secondRecoveryAttempts).toHaveLength(0);
  }, 30_000);

  it("never heals when the journey has no allowedRecoveryActions — recovery never even runs", async () => {
    const { map, journey: staleJourney } = buildStaleSelectorMap();
    const journeyWithoutRecovery: UserJourney = { ...staleJourney, allowedRecoveryActions: [] };
    const mapWithoutRecovery: ApplicationTestMap = {
      ...map,
      areas: [{ ...map.areas[0], journeys: [journeyWithoutRecovery] }],
    };
    runtime.testMaps.save(mapWithoutRecovery);

    const context = { environment: "local", fixtureIds: [] };
    const run = await startJourneyRun(
      runtime,
      runtime.testMaps,
      mapWithoutRecovery,
      journeyWithoutRecovery,
      context,
    );
    const result = runtime.repository.get(run.runId);
    expect(result?.status).toBe("failed");

    const untouchedMap = runtime.testMaps.get(map.id);
    const untouchedStep = untouchedMap?.areas[0]?.journeys[0]?.checkpoints[0]?.steps[1];
    expect(untouchedStep?.selector).toBe("#stale-newsletter-button-id");
  }, 30_000);
});
