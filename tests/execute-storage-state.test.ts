import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { executeTestCase } from "../src/services/browser/execute.js";
import type { TargetManifest, TestCase } from "../src/domain/index.js";

// Regression for a real bug: journey execution's browser context ignored
// `TargetManifest.storageStatePath` entirely (it called
// `browser.newContext()` with no arguments), so a run against a map
// captured while signed in silently executed as an anonymous visitor —
// discovered while wiring up the persona/session-reuse flow. This test
// proves execution actually authenticates: a tiny HTTP server echoes the
// request's Cookie header into the page body, and a captured
// storageState cookie must appear there for the assertion to pass.

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const cookie = request.headers.cookie ?? "none";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><body>Cookie: ${cookie}</body></html>`);
  });
  const { promise: listening, resolve: listeningReady } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listeningReady);
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind the cookie-echo test server.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  const { promise: closed, resolve: closedReady } = Promise.withResolvers<void>();
  server.close(() => closedReady());
  await closed;
});

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-execute-storage-state-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function buildManifest(storageStatePath?: string): TargetManifest {
  return {
    targetId: "127.0.0.1",
    baseUrl,
    allowedDomains: ["127.0.0.1"],
    environment: "local",
    description: "Cookie-echo test target",
    runExecutionMode: "observe",
    storageStatePath,
    createdAt: new Date().toISOString(),
  };
}

function buildCase(expectedCookieFragment: string): TestCase {
  return {
    id: `case-${randomUUID()}`,
    title: "Loads the cookie-echo page",
    preconditions: [],
    steps: [{ kind: "navigate", url: baseUrl, timeoutMs: 10_000 }],
    assertions: [{ kind: "textVisible", expected: expectedCookieFragment }],
    allowedDomains: ["127.0.0.1"],
    executionMode: "read_only",
    riskLevel: "low",
    timeoutMs: 30_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryBudget: 0,
  };
}

describe("executeTestCase honors manifest.storageStatePath", () => {
  it("sends a captured cookie to the target when storageStatePath is set", async () => {
    const storageStatePath = join(tempDir, "session.json");
    writeFileSync(
      storageStatePath,
      JSON.stringify({
        cookies: [
          {
            name: "nova_session",
            value: "reused-abc123",
            domain: "127.0.0.1",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    );

    const result = await executeTestCase({
      runId: randomUUID(),
      manifest: buildManifest(storageStatePath),
      testCase: buildCase("reused-abc123"),
      artifactsDirectory: tempDir,
      secretResolver: { resolve: () => undefined },
    });

    expect(result.assertionResults[0]?.passed).toBe(true);
  }, 20_000);

  it("sends no cookie when storageStatePath is omitted — never a false pass from a stale global browser profile", async () => {
    const result = await executeTestCase({
      runId: randomUUID(),
      manifest: buildManifest(undefined),
      testCase: buildCase("none"),
      artifactsDirectory: tempDir,
      secretResolver: { resolve: () => undefined },
    });

    expect(result.assertionResults[0]?.passed).toBe(true);
  }, 20_000);
});
