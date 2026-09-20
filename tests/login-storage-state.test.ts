import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { captureStorageState } from "../src/services/browser/login.js";

// A real static server for fixtures/demo-app's login page, and a real
// headed browser inside captureStorageState — exactly what `nova login`
// opens for an operator. No mocked Playwright, no stubbed browser
// context.
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-login-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("captureStorageState", () => {
  it("opens a real headed browser at the target URL, waits for the operator, then captures a well-formed session with 0600 permissions", async () => {
    const outputPath = join(tempDir, "session.json");
    let waitedForOperator = false;

    const result = await captureStorageState({
      url: `${baseUrl}/login.html`,
      outputPath,
      waitForOperator: async () => {
        // The real assertion here is ordering: the output file must not
        // exist yet when the operator's wait resolves — capture happens
        // strictly after, never before or concurrently.
        expect(existsSync(outputPath)).toBe(false);
        waitedForOperator = true;
      },
    });

    expect(waitedForOperator).toBe(true);
    expect(result.outputPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);

    const stat = statSync(outputPath);
    expect(stat.mode & 0o777).toBe(0o600);

    const saved = JSON.parse(readFileSync(outputPath, "utf8")) as {
      cookies: unknown[];
      origins: unknown[];
    };
    expect(Array.isArray(saved.cookies)).toBe(true);
    expect(Array.isArray(saved.origins)).toBe(true);
  }, 30_000);

  it("creates the output directory when it does not already exist", async () => {
    const outputPath = join(tempDir, "nested", "sessions", "session.json");
    const result = await captureStorageState({
      url: `${baseUrl}/login.html`,
      outputPath,
      waitForOperator: async () => {},
    });
    expect(result.outputPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
  }, 30_000);

  it("never reads or captures the demo login form's field values into the session file", async () => {
    const outputPath = join(tempDir, "session.json");
    await captureStorageState({
      url: `${baseUrl}/login.html`,
      outputPath,
      waitForOperator: async () => {},
    });

    const raw = readFileSync(outputPath, "utf8");
    // captureStorageState never fills the form or types anything; the
    // literal fixture password string must never appear in the output.
    expect(raw).not.toContain("not-a-real-password");
  }, 30_000);

  it("propagates a navigation failure and never writes a partial session file", async () => {
    const outputPath = join(tempDir, "session.json");
    await expect(
      captureStorageState({
        url: "http://127.0.0.1:1/unreachable",
        outputPath,
        waitForOperator: async () => {},
      }),
    ).rejects.toThrow();
    expect(existsSync(outputPath)).toBe(false);
  }, 30_000);
});
