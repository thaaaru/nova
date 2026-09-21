import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationTestMap } from "../src/domain/index.js";
import { SqliteApplicationTestMapRepository } from "../src/services/persistence/test-map-repository.js";

let tempDir: string;
let databasePath: string;
let testMapDatabasePath: string;
let artifactsDirectory: string;

function buildMap(): ApplicationTestMap {
  const now = new Date().toISOString();
  return {
    id: "map-curate-demo",
    version: "1.0.0",
    applicationName: "Curate Demo",
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
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-journey-curate-test-"));
  databasePath = join(tempDir, "nova.sqlite");
  testMapDatabasePath = join(tempDir, "nova-test-map.sqlite");
  artifactsDirectory = join(tempDir, "artifacts");

  const repository = new SqliteApplicationTestMapRepository(testMapDatabasePath);
  repository.save(buildMap());
  repository.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function runNova(args: string[]): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node_modules/.bin/tsx", ["src/cli/index.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NOVA_NO_UPDATE_CHECK: "1",
        NOVA_DATABASE_PATH: databasePath,
        NOVA_ARTIFACTS_DIR: artifactsDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "" };
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`nova ${args.join(" ")} failed: ${message}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

describe("nova journey curate", () => {
  it("writes steps/assertions onto the draft checkpoint and unblocks approval", () => {
    const stepsFile = join(tempDir, "steps.json");
    writeFileSync(
      stepsFile,
      JSON.stringify({
        steps: [{ kind: "navigate", url: "https://shop.example.test" }],
        assertions: [{ kind: "urlContains", expected: "shop.example.test" }],
      }),
    );

    const { stdout } = runNova([
      "journey",
      "curate",
      "journey-1",
      "--map",
      "map-curate-demo",
      "--steps-file",
      stepsFile,
      "--json",
    ]);
    const result = JSON.parse(stdout.trim());
    expect(result).toEqual({
      journeyId: "journey-1",
      checkpointId: "checkpoint-draft",
      stepCount: 1,
      assertionCount: 1,
    });

    const repository = new SqliteApplicationTestMapRepository(testMapDatabasePath);
    try {
      const map = repository.get("map-curate-demo");
      expect(map?.areas[0].journeys[0].checkpoints[0].steps).toHaveLength(1);
      expect(map?.areas[0].journeys[0].checkpoints[0].assertions).toHaveLength(1);
    } finally {
      repository.close();
    }

    const approve = runNova(["journey", "approve", "journey-1", "--map", "map-curate-demo", "--json"]);
    expect(JSON.parse(approve.stdout.trim())).toEqual({
      journeyId: "journey-1",
      map: "map-curate-demo",
      status: "approved",
    });
  }, 60_000);

  it("fails with a clear error for an unknown checkpoint id", () => {
    const stepsFile = join(tempDir, "steps.json");
    writeFileSync(stepsFile, JSON.stringify({ steps: [{ kind: "navigate" }], assertions: [] }));
    expect(() =>
      runNova([
        "journey",
        "curate",
        "journey-1",
        "--map",
        "map-curate-demo",
        "--checkpoint",
        "not-a-real-checkpoint",
        "--steps-file",
        stepsFile,
      ]),
    ).toThrow(/Unknown checkpoint/);
  }, 30_000);

  it("fails with a clear error when the steps file has no assertions", () => {
    const stepsFile = join(tempDir, "steps.json");
    writeFileSync(stepsFile, JSON.stringify({ steps: [{ kind: "navigate" }], assertions: [] }));
    expect(() =>
      runNova(["journey", "curate", "journey-1", "--map", "map-curate-demo", "--steps-file", stepsFile]),
    ).toThrow();
  }, 30_000);
});
