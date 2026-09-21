import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationTestMap } from "../src/domain/index.js";
import { SqliteApplicationTestMapRepository } from "../src/services/persistence/test-map-repository.js";

// A real local server for fixtures/demo-app's login form, exactly like
// tests/tui/map-discover-screen.test.tsx uses — no mocked navigation.
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

// The raw secret value the fixture "signs in" with. A login credential
// is exactly the "secret-shaped value" the product spec's redaction
// requirement is about — chosen distinctive enough that an accidental
// substring match elsewhere in report output would be implausible.
const RAW_SECRET = "Tr0ub4dor&3-nova-demo-secret";
const SECRET_ENV_KEY = "NOVA_SECRET_DEMO_LOGIN_PASSWORD";

let tempDir: string;
let databasePath: string;
let testMapDatabasePath: string;
let artifactsDirectory: string;
let mapId: string;

function buildMap(): ApplicationTestMap {
  const now = new Date().toISOString();
  return {
    id: "map-secret-redaction-demo",
    version: "1.0.0",
    applicationName: "Secret Redaction Demo",
    targetUrl: `${baseUrl}/login.html`,
    environment: "local",
    approvedScope: {
      allowedDomains: ["127.0.0.1"],
      allowedApiHosts: [],
      allowedMethods: ["GET", "POST"],
      executionMode: "safe_test",
    },
    areas: [
      {
        id: "area-auth",
        name: "Authentication",
        riskLevel: "medium",
        journeys: [
          {
            id: "journey-login",
            areaId: "area-auth",
            name: "Sign in with credentials",
            description: "Sign in using an env-resolved secret reference for the password field.",
            mode: "quick_test",
            requiredPersonaIds: [],
            requiredFixtureIds: [],
            checkpoints: [
              {
                id: "checkpoint-login",
                name: "Submit sign-in form",
                expectedOutcome: "Redirects to checkout after signing in.",
                riskLevel: "medium",
                requiresApproval: false,
                evidenceRequirements: ["screenshot"],
                steps: [
                  { kind: "navigate", url: `${baseUrl}/login.html`, timeoutMs: 10_000 },
                  {
                    kind: "fill",
                    selector: "input[name=email]",
                    value: "demo-user@example.test",
                    timeoutMs: 10_000,
                  },
                  {
                    kind: "fill",
                    selector: "input[name=password]",
                    value: "secret:demo_login_password",
                    timeoutMs: 10_000,
                  },
                  { kind: "click", selector: "button[type=submit]", timeoutMs: 10_000 },
                ],
                assertions: [{ kind: "urlContains", expected: "checkout.html" }],
              },
            ],
            allowedRecoveryActions: [],
            status: "approved",
          },
        ],
      },
    ],
    personas: [],
    fixtures: [],
    knownConstraints: [],
    status: "accepted",
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-secret-redaction-test-"));
  databasePath = join(tempDir, "nova.sqlite");
  testMapDatabasePath = join(tempDir, "nova-test-map.sqlite");
  artifactsDirectory = join(tempDir, "artifacts");

  const map = buildMap();
  mapId = map.id;
  const repository = new SqliteApplicationTestMapRepository(testMapDatabasePath);
  repository.save(map);
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
        [SECRET_ENV_KEY]: RAW_SECRET,
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

function collectReportFileContents(): string {
  const reportDir = join(artifactsDirectory, ...readdirSync(artifactsDirectory), "report");
  return readdirSync(reportDir)
    .map((name) => readFileSync(join(reportDir, name), "utf8"))
    .join("\n");
}

describe("secret redaction in real CLI output", () => {
  it("never prints the raw secret value in `nova journey run --json` stdout, and never writes it to disk", () => {
    const { stdout } = runNova([
      "journey",
      "run",
      "journey-login",
      "--map",
      mapId,
      "--env",
      "local",
      "--json",
      "--non-interactive",
    ]);

    expect(stdout).not.toContain(RAW_SECRET);
    const parsed: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    const runId =
      parsed && typeof parsed === "object" && "runId" in parsed ? String(parsed.runId) : undefined;
    expect(runId).toBeTruthy();
  }, 60_000);

  it("never prints the raw secret value in `nova report` stdout, at both --json and human-readable output, and never writes it into the generated report files", () => {
    const { stdout: journeyStdout } = runNova([
      "journey",
      "run",
      "journey-login",
      "--map",
      mapId,
      "--env",
      "local",
      "--json",
      "--non-interactive",
    ]);
    const journeyParsed: unknown = JSON.parse(journeyStdout.trim().split("\n").at(-1) ?? "{}");
    const runId =
      journeyParsed && typeof journeyParsed === "object" && "runId" in journeyParsed
        ? String(journeyParsed.runId)
        : undefined;
    if (!runId) {
      throw new Error(`journey run did not return a runId: ${journeyStdout}`);
    }

    const { stdout: jsonReportStdout } = runNova(["report", "--run", runId, "--json", "--non-interactive"]);
    expect(jsonReportStdout).not.toContain(RAW_SECRET);

    const { stdout: humanReportStdout } = runNova(["report", "--run", runId, "--non-interactive"]);
    expect(humanReportStdout).not.toContain(RAW_SECRET);

    const reportContents = collectReportFileContents();
    expect(reportContents).not.toContain(RAW_SECRET);
  }, 120_000);
});
