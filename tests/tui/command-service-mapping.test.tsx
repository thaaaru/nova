import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

import { buildRuntime, type NovaRuntime } from "../../src/cli/context.js";
import { App } from "../../src/tui/app.js";

// Proves src/cli/index.ts's `nova discover ...` command and
// src/tui/app.tsx's `:discover --target ...` command-mode path both call
// the exact same `runDiscover` export from src/cli/commands.ts, rather
// than two independently maintained copies of the same business logic —
// same for plan/approve/report. Verified by observing the real command
// handlers run against a real (scratch, sqlite-backed) runtime: no
// mocking, no stubbing of commands.ts, just two different entry points
// hitting the identical persisted state after each drives the same
// underlying function.

// A real local server for fixtures/demo-app, exactly like
// tests/tui/map-discover-screen.test.tsx — discover crawls a real page,
// never a mocked network response.
let server: Server;
let baseUrl: string;
let target: string;

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
  target = `${baseUrl}/index.html`;
});

afterAll(async () => {
  const { promise: closed, resolve: closedReady } = Promise.withResolvers<void>();
  server.close(() => closedReady());
  await closed;
});

let tempDir: string;
let databasePath: string;
let artifactsDir: string;
let runtime: NovaRuntime;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-command-mapping-test-"));
  databasePath = join(tempDir, "nova.sqlite");
  artifactsDir = join(tempDir, "artifacts");
  runtime = buildRuntime({ databasePath, artifactsDirectory: artifactsDir, headless: true });
});

afterEach(() => {
  runtime.repository.close();
  runtime.testMaps.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function runNova(args: string[]): string {
  return execFileSync("node_modules/.bin/tsx", ["src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NOVA_NO_UPDATE_CHECK: "1",
      NOVA_DATABASE_PATH: databasePath,
      NOVA_ARTIFACTS_DIR: artifactsDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function settle(ms = 300): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

async function typeAndSubmit(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  stdin.write(text);
  await settle(50);
  stdin.write("\r");
  await settle(400);
}

/** No map exists yet, so the home menu's numbered options are: 1 discover-app … 8 command-mode. */
async function openCommandMode(stdin: { write: (data: string) => void }): Promise<void> {
  stdin.write("8");
  await settle();
}

function parseDiscoveredRunId(discoverOutput: string): string {
  const runId = /^Run (\S+):/m.exec(discoverOutput)?.[1];
  if (!runId) {
    throw new Error(`Could not parse run id from discover output: ${discoverOutput}`);
  }
  return runId;
}

// The TUI's `:discover` runs a real browser crawl asynchronously —
// unmounting right after submitting the command line would race its
// completion, so poll the real run repository (the same one both paths
// write through) until the new run reaches a terminal discover status.
async function waitForRun(
  predicate: () => boolean,
  { timeoutMs = 30_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for the run repository to update.`);
    }
    await settle(intervalMs);
  }
}

describe("CLI and TUI command-mode dispatch the same commands.ts functions", () => {
  it("`nova discover` and TUI `:discover --target ...` both persist a run discovered via runDiscover, in the same run repository", async () => {
    const cliOutput = runNova(["discover", "--target", target, "--non-interactive"]);
    const cliRunId = parseDiscoveredRunId(cliOutput);
    const cliRuns = runtime.repository.list();
    expect(cliRuns).toHaveLength(1);
    expect(cliRuns[0]?.targetManifest.baseUrl).toBe(target);
    expect(cliRuns[0]?.status).toBe("planning");

    const { stdin, unmount } = render(<App runtime={runtime} />);
    await settle();
    await openCommandMode(stdin);
    await typeAndSubmit(stdin, `discover --target ${target}`);
    await waitForRun(() =>
      runtime.repository.list().some((run) => run.runId !== cliRunId && run.status === "planning"),
    );
    unmount();

    const allRuns = runtime.repository.list();
    expect(allRuns).toHaveLength(2);
    const tuiRun = allRuns.find((run) => run.runId !== cliRunId);
    expect(tuiRun?.targetManifest.baseUrl).toBe(target);
    expect(tuiRun?.status).toBe("planning");
  }, 60_000);

  it("`nova plan` and TUI `:plan --objective ...` both produce a TestPlan via runPlan for the run they target", async () => {
    const cliDiscoverOut = runNova(["discover", "--target", target, "--non-interactive"]);
    const cliRunId = parseDiscoveredRunId(cliDiscoverOut);

    runNova(["plan", "--objective", "Confirm the storefront loads", "--run", cliRunId]);
    const afterCliPlan = runtime.repository.get(cliRunId);
    expect(afterCliPlan?.testPlan).toBeDefined();
    expect(afterCliPlan?.status).toBe("awaiting_approval");

    // A fresh discovered run, planned through the TUI's `:plan`
    // command-mode path instead of the CLI. `:plan` never takes a
    // `--run` flag (see to-intent.ts) — it always targets the current
    // run pointer runDiscover just set, exactly like plain `nova plan`
    // with no `--run` would.
    const tuiDiscoverOut = runNova(["discover", "--target", target, "--non-interactive"]);
    const tuiRunId = parseDiscoveredRunId(tuiDiscoverOut);

    const { stdin, unmount } = render(<App runtime={runtime} />);
    await settle();
    await openCommandMode(stdin);
    await typeAndSubmit(stdin, 'plan --objective "Confirm the storefront loads"');
    await waitForRun(() => runtime.repository.get(tuiRunId)?.status === "awaiting_approval");
    unmount();

    const afterTuiPlan = runtime.repository.get(tuiRunId);
    expect(afterTuiPlan?.testPlan).toBeDefined();
    expect(afterTuiPlan?.status).toBe("awaiting_approval");
  }, 60_000);

  it("`nova approve` and TUI `:approve --plan ...` both record an approval decision via runApprove", async () => {
    const cliDiscoverOut = runNova(["discover", "--target", target, "--non-interactive"]);
    const cliRunId = parseDiscoveredRunId(cliDiscoverOut);
    runNova(["plan", "--objective", "Confirm the storefront loads", "--run", cliRunId]);

    runNova(["approve", "--plan", cliRunId]);
    const afterCliApprove = runtime.repository.get(cliRunId);
    expect(afterCliApprove?.approval?.decision).toBe("approved");
    expect(afterCliApprove?.status).toBe("approved");

    // A second discover/plan cycle, approved through the TUI's
    // `:approve` command-mode path instead of the CLI.
    const tuiDiscoverOut = runNova(["discover", "--target", target, "--non-interactive"]);
    const tuiRunId = parseDiscoveredRunId(tuiDiscoverOut);
    runNova(["plan", "--objective", "Confirm the storefront loads", "--run", tuiRunId]);

    const { stdin, unmount } = render(<App runtime={runtime} />);
    await settle();
    await openCommandMode(stdin);
    await typeAndSubmit(stdin, `approve --plan ${tuiRunId}`);
    await waitForRun(() => runtime.repository.get(tuiRunId)?.status === "approved");
    unmount();

    const afterTuiApprove = runtime.repository.get(tuiRunId);
    expect(afterTuiApprove?.approval?.decision).toBe("approved");
    expect(afterTuiApprove?.status).toBe("approved");
  }, 60_000);

  it("`nova report` and TUI `:report --run ...` both write the same report files via runReport", async () => {
    const cliDiscoverOut = runNova(["discover", "--target", target, "--non-interactive"]);
    const cliRunId = parseDiscoveredRunId(cliDiscoverOut);

    const cliReportOut = runNova(["report", "--run", cliRunId, "--non-interactive"]);
    expect(cliReportOut).toContain("report.json");
    const cliReportJsonPath = join(artifactsDir, cliRunId, "report", "report.json");
    expect(existsSync(cliReportJsonPath)).toBe(true);

    const tuiDiscoverOut = runNova(["discover", "--target", target, "--non-interactive"]);
    const tuiRunId = parseDiscoveredRunId(tuiDiscoverOut);
    const tuiReportJsonPath = join(artifactsDir, tuiRunId, "report", "report.json");
    expect(existsSync(tuiReportJsonPath)).toBe(false);

    const { stdin, unmount } = render(<App runtime={runtime} />);
    await settle();
    await openCommandMode(stdin);
    await typeAndSubmit(stdin, `report --run ${tuiRunId}`);
    await waitForRun(() => existsSync(tuiReportJsonPath));
    unmount();

    // runReport (commands.ts) always writes to
    // `${artifactsDirectory}/${runId}/report/report.json` regardless of
    // caller — the TUI's `:report` command wrote through that same
    // function, to the same shape of path the CLI's `nova report` used.
    expect(existsSync(tuiReportJsonPath)).toBe(true);
  }, 60_000);
});
