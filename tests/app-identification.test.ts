import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { DiscoverySnapshot } from "../src/domain/index.js";
import type { NovaRuntime } from "../src/cli/context.js";
import { curateCheckpoint, resolveApplicationName } from "../src/services/testmap/map-service.js";
import { SqliteApplicationTestMapRepository } from "../src/services/persistence/test-map-repository.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function snapshot(): DiscoverySnapshot {
  return {
    runId: randomUUID(),
    targetUrl: "https://shop.example.test",
    visitedUrls: ["https://shop.example.test"],
    pages: [
      {
        url: "https://shop.example.test",
        title: "Acme Shop — Home",
        forms: [],
        buttons: [],
        links: [],
        consoleErrors: [],
      },
    ],
    apiEndpoints: [],
    capturedAt: new Date().toISOString(),
  };
}

/**
 * resolveApplicationName only ever reads `runtime.appIdentifier`, so a
 * minimal stub runtime is a faithful exercise of its real contract, not a
 * mock of a dependency it doesn't otherwise use.
 */
function runtimeWithIdentifier(appIdentifier?: NovaRuntime["appIdentifier"]): NovaRuntime {
  return { appIdentifier } as unknown as NovaRuntime;
}

describe("resolveApplicationName", () => {
  it("always prefers an explicitly provided name, even when an identifier is configured", async () => {
    const runtime = runtimeWithIdentifier(async () => ({ name: "LLM Guess", description: "..." }));
    const name = await resolveApplicationName(
      runtime,
      "https://shop.example.test",
      "Explicit Name",
      snapshot(),
    );
    expect(name).toBe("Explicit Name");
  });

  it("uses the LLM identifier's name when no explicit name is provided", async () => {
    const runtime = runtimeWithIdentifier(async () => ({
      name: "Acme Shop",
      description: "An e-commerce storefront.",
    }));
    const name = await resolveApplicationName(runtime, "https://shop.example.test", undefined, snapshot());
    expect(name).toBe("Acme Shop");
  });

  it("falls back to a deterministic URL-derived name when no identifier is configured", async () => {
    const runtime = runtimeWithIdentifier(undefined);
    const name = await resolveApplicationName(runtime, "https://shop.example.test", undefined, snapshot());
    expect(name).toBe("Shop");
  });

  it("falls back to the URL-derived name when the identifier call fails", async () => {
    const runtime = runtimeWithIdentifier(async () => {
      throw new Error("network error");
    });
    const name = await resolveApplicationName(runtime, "https://shop.example.test", undefined, snapshot());
    expect(name).toBe("Shop");
  });

  it("falls back to the URL-derived name when the identifier returns a blank name", async () => {
    const runtime = runtimeWithIdentifier(async () => ({ name: "   ", description: "..." }));
    const name = await resolveApplicationName(runtime, "https://shop.example.test", undefined, snapshot());
    expect(name).toBe("Shop");
  });

  it("treats a whitespace-only explicit name as not provided", async () => {
    const runtime = runtimeWithIdentifier(async () => ({ name: "Acme Shop", description: "..." }));
    const name = await resolveApplicationName(runtime, "https://shop.example.test", "   ", snapshot());
    expect(name).toBe("Acme Shop");
  });
});

describe("curateCheckpoint", () => {
  it("writes steps/assertions onto a draft journey's checkpoint so it can be approved", () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-curate-"));
    const testMaps = new SqliteApplicationTestMapRepository(join(dir, "maps.sqlite"));
    try {
      const now = new Date().toISOString();
      testMaps.save({
        id: "map-1",
        version: "1.0.0",
        applicationName: "Acme Shop",
        targetUrl: "https://shop.example.test",
        environment: "staging",
        approvedScope: {
          allowedDomains: ["shop.example.test"],
          allowedApiHosts: [],
          allowedMethods: ["GET"],
          executionMode: "safe_test",
        },
        areas: [
          {
            id: "area-1",
            name: "Home",
            riskLevel: "low",
            journeys: [
              {
                id: "journey-1",
                areaId: "area-1",
                name: "Describe: buy a widget",
                description: "buy a widget",
                mode: "guided_test",
                requiredPersonaIds: [],
                requiredFixtureIds: [],
                checkpoints: [
                  {
                    id: "checkpoint-draft",
                    name: "Describe expected outcome",
                    expectedOutcome: "A QA engineer curates concrete checkpoints and steps.",
                    riskLevel: "medium",
                    requiresApproval: true,
                    evidenceRequirements: ["screenshot"],
                    steps: [],
                    assertions: [],
                  },
                ],
                allowedRecoveryActions: [],
                status: "draft",
              },
            ],
          },
        ],
        personas: [],
        fixtures: [],
        knownConstraints: [],
        status: "draft",
        createdAt: now,
        updatedAt: now,
      });

      const runtime = { testMaps } as unknown as NovaRuntime;
      const updated = curateCheckpoint(
        runtime,
        "map-1",
        "journey-1",
        "checkpoint-draft",
        [{ kind: "navigate", url: "https://shop.example.test", timeoutMs: 10_000 }],
        [{ kind: "urlContains", expected: "shop.example.test" }],
      );

      expect(updated.checkpoints[0].steps).toHaveLength(1);
      expect(updated.checkpoints[0].assertions).toHaveLength(1);

      const persisted = testMaps.get("map-1");
      expect(persisted?.areas[0].journeys[0].checkpoints[0].steps).toHaveLength(1);
    } finally {
      testMaps.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for an unknown checkpoint id", () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-curate-"));
    const testMaps = new SqliteApplicationTestMapRepository(join(dir, "maps.sqlite"));
    try {
      const now = new Date().toISOString();
      testMaps.save({
        id: "map-1",
        version: "1.0.0",
        applicationName: "Acme Shop",
        targetUrl: "https://shop.example.test",
        environment: "staging",
        approvedScope: {
          allowedDomains: ["shop.example.test"],
          allowedApiHosts: [],
          allowedMethods: ["GET"],
          executionMode: "safe_test",
        },
        areas: [
          {
            id: "area-1",
            name: "Home",
            riskLevel: "low",
            journeys: [
              {
                id: "journey-1",
                areaId: "area-1",
                name: "Describe: buy a widget",
                description: "buy a widget",
                mode: "guided_test",
                requiredPersonaIds: [],
                requiredFixtureIds: [],
                checkpoints: [
                  {
                    id: "checkpoint-draft",
                    name: "Describe expected outcome",
                    expectedOutcome: "A QA engineer curates concrete checkpoints and steps.",
                    riskLevel: "medium",
                    requiresApproval: true,
                    evidenceRequirements: ["screenshot"],
                    steps: [],
                    assertions: [],
                  },
                ],
                allowedRecoveryActions: [],
                status: "draft",
              },
            ],
          },
        ],
        personas: [],
        fixtures: [],
        knownConstraints: [],
        status: "draft",
        createdAt: now,
        updatedAt: now,
      });

      const runtime = { testMaps } as unknown as NovaRuntime;
      expect(() => curateCheckpoint(runtime, "map-1", "journey-1", "not-a-real-checkpoint", [], [])).toThrow(
        /Unknown checkpoint/,
      );
    } finally {
      testMaps.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
