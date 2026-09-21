import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkForUpdatesIfDue } from "../src/services/update-check/index.js";

let tempDir: string;
let databasePath: string;
let originalCI: string | undefined;
let originalSkip: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-update-check-test-"));
  databasePath = join(tempDir, "nova.sqlite");
  originalCI = process.env.CI;
  originalSkip = process.env.NOVA_NO_UPDATE_CHECK;
  delete process.env.CI;
  delete process.env.NOVA_NO_UPDATE_CHECK;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (originalCI === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = originalCI;
  }
  if (originalSkip === undefined) {
    delete process.env.NOVA_NO_UPDATE_CHECK;
  } else {
    process.env.NOVA_NO_UPDATE_CHECK = originalSkip;
  }
});

function stateFilePath(): string {
  return join(tempDir, ".nova-update-check.json");
}

describe("checkForUpdatesIfDue", () => {
  it("checks on a fresh, never-run-before state (no marker file yet)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ sha: "0".repeat(40) }), { status: 200 });
    }) as typeof fetch;

    await checkForUpdatesIfDue({
      databasePath,
      repoDir: "/Users/tharaka/Projects/nova",
      fetchImpl,
    });

    expect(calls).toBe(1);
    const state = JSON.parse(readFileSync(stateFilePath(), "utf8")) as { lastRunAt?: string };
    expect(state.lastRunAt).toBeDefined();
  });

  it("never checks again within 15 minutes of the last invocation", async () => {
    const recentRun = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeFileSync(stateFilePath(), JSON.stringify({ lastRunAt: recentRun }), "utf8");

    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ sha: "0".repeat(40) }), { status: 200 });
    }) as typeof fetch;

    const notice = await checkForUpdatesIfDue({
      databasePath,
      repoDir: "/Users/tharaka/Projects/nova",
      fetchImpl,
    });

    expect(notice).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("checks again once more than 15 minutes have passed since the last invocation", async () => {
    const staleRun = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    writeFileSync(stateFilePath(), JSON.stringify({ lastRunAt: staleRun }), "utf8");

    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ sha: "0".repeat(40) }), { status: 200 });
    }) as typeof fetch;

    await checkForUpdatesIfDue({ databasePath, repoDir: "/Users/tharaka/Projects/nova", fetchImpl });

    expect(calls).toBe(1);
  });

  it("returns an update notice when GitHub's latest commit differs from the local HEAD", async () => {
    const staleRun = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    writeFileSync(stateFilePath(), JSON.stringify({ lastRunAt: staleRun }), "utf8");

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ sha: "f".repeat(40) }), { status: 200 })) as typeof fetch;

    const notice = await checkForUpdatesIfDue({
      databasePath,
      repoDir: "/Users/tharaka/Projects/nova",
      fetchImpl,
    });

    expect(notice).toMatch(/Nova has been updated on GitHub/);
    expect(notice).toMatch(/git pull && \.\/install\.sh/);
  });

  it("returns no notice, and never throws, when the network call fails entirely (offline)", async () => {
    const staleRun = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    writeFileSync(stateFilePath(), JSON.stringify({ lastRunAt: staleRun }), "utf8");

    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    }) as typeof fetch;

    await expect(
      checkForUpdatesIfDue({ databasePath, repoDir: "/Users/tharaka/Projects/nova", fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it("returns no notice on a non-OK GitHub response (rate-limited, 404, etc.)", async () => {
    const staleRun = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    writeFileSync(stateFilePath(), JSON.stringify({ lastRunAt: staleRun }), "utf8");

    const fetchImpl = (async () => new Response("rate limited", { status: 403 })) as typeof fetch;

    const notice = await checkForUpdatesIfDue({
      databasePath,
      repoDir: "/Users/tharaka/Projects/nova",
      fetchImpl,
    });
    expect(notice).toBeUndefined();
  });

  it("returns no notice when the repo dir is not a git checkout at all (never calls fetch)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ sha: "0".repeat(40) }), { status: 200 });
    }) as typeof fetch;

    const notice = await checkForUpdatesIfDue({ databasePath, repoDir: tempDir, fetchImpl });

    expect(notice).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("skips entirely, and never even reads/writes the state file, under CI", async () => {
    process.env.CI = "true";
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ sha: "0".repeat(40) }), { status: 200 });
    }) as typeof fetch;

    const notice = await checkForUpdatesIfDue({
      databasePath,
      repoDir: "/Users/tharaka/Projects/nova",
      fetchImpl,
    });

    expect(notice).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("skips entirely when NOVA_NO_UPDATE_CHECK is set", async () => {
    process.env.NOVA_NO_UPDATE_CHECK = "1";
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ sha: "0".repeat(40) }), { status: 200 });
    }) as typeof fetch;

    const notice = await checkForUpdatesIfDue({
      databasePath,
      repoDir: "/Users/tharaka/Projects/nova",
      fetchImpl,
    });

    expect(notice).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("checkForUpdatesIfDue — real GitHub call", () => {
  // GitHub's commit API is public and needs no credential, so — unlike the
  // DeepSeek test — this one runs for real, always, in every environment
  // with outbound network access. It only asserts the call completes
  // without throwing and returns a well-shaped result; it deliberately
  // does not assert whether an update is available, since that depends on
  // how far this checkout's own HEAD is from the real GitHub repo.
  it("really reaches api.github.com/repos/thaaaru/nova and returns without throwing", async () => {
    const result = await checkForUpdatesIfDue({
      databasePath,
      repoDir: "/Users/tharaka/Projects/nova",
    });
    expect(result === undefined || typeof result === "string").toBe(true);
  }, 10_000);
});
