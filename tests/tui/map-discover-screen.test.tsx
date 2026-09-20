import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

import { buildRuntime, type NovaRuntime } from "../../src/cli/context.js";
import { MapDiscoverScreen } from "../../src/tui/screens/MapDiscoverScreen.js";

// A real static file server for fixtures/demo-app, exactly like a QA
// engineer would point Nova at a real running application — no mocked
// discovery, no stubbed Playwright.
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-map-discover-screen-test-"));
  runtime = buildRuntime({
    databasePath: join(tempDir, "nova.sqlite"),
    artifactsDirectory: join(tempDir, "artifacts"),
    headless: true,
  });
});

afterEach(() => {
  runtime.repository.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// Ink's `useInput` subscription on a screen that just mounted after a
// phase transition needs a tick to settle before the next keypress is
// reliably observed by the newly-mounted component — not a logic bug in
// the screen; a timing property of ink-testing-library's stdin
// simulation. Verified with debug logging during the original TUI
// friction-fix session; the 300ms margin here is generous, not tuned to
// the edge.
async function settle(ms = 300): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

// Writing text then "\r" in the same tick can submit before ink-text-input
// has applied the text to its controlled value — a brief settle between
// the keystrokes and Enter avoids racing that state update.
async function typeAndSubmit(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  stdin.write(text);
  await settle(50);
  stdin.write("\r");
  await settle();
}

async function pressEnter(stdin: { write: (data: string) => void }): Promise<void> {
  stdin.write("\r");
  await settle();
}

// The application-name field starts pre-filled with a name derived from
// the target's hostname; the cursor sits at the end of that text, so
// typing without clearing it first would append rather than replace —
// clear it with enough backspaces first, exactly as an operator would.
async function clearAndType(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  // Each backspace must land in its own tick — ink-text-input reads the
  // current value from its React closure, so a burst of backspace bytes
  // delivered before a re-render all operate on the same stale value.
  for (let index = 0; index < 40; index += 1) {
    stdin.write("\u007F");
    await settle(20);
  }
  await typeAndSubmit(stdin, text);
}

describe("MapDiscoverScreen", () => {
  it("walks target URL -> name -> environment -> no-auth -> confirm and drafts a real map from a live target", async () => {
    let completedMap: string | undefined;
    const { stdin, lastFrame } = render(
      <MapDiscoverScreen
        runtime={runtime}
        onComplete={(map) => {
          completedMap = map.applicationName;
        }}
        onCancel={() => {
          throw new Error("onCancel should not fire in this flow");
        }}
      />,
    );

    await typeAndSubmit(stdin, baseUrl);

    expect(lastFrame() ?? "").toContain("Application name");
    await clearAndType(stdin, "Demo Shop");

    expect(lastFrame() ?? "").toContain("Environment");
    await pressEnter(stdin); // accept the pre-selected environment

    expect(lastFrame() ?? "").toContain("require sign-in");
    await pressEnter(stdin); // accept "No — public pages only"

    expect(lastFrame() ?? "").toContain("Crawl");
    expect(lastFrame() ?? "").not.toContain("signed in via");
    await pressEnter(stdin); // confirm and start discovery

    // Real, non-mocked discovery against the live demo server — poll
    // for the draft summary instead of a fixed sleep since crawl
    // duration varies with system load, then press Enter to accept the
    // draft, exactly like a QA engineer reviewing "MAP DRAFTED" before
    // moving on.
    const draftDeadline = Date.now() + 20_000;
    while (!(lastFrame() ?? "").includes("MAP DRAFTED") && Date.now() < draftDeadline) {
      await settle(200);
    }
    expect(lastFrame() ?? "").toContain("MAP DRAFTED");
    await pressEnter(stdin);

    expect(completedMap).toBe("Demo Shop");
    const savedMaps = runtime.testMaps.list();
    expect(savedMaps).toHaveLength(1);
    expect(savedMaps[0]?.approvedScope.storageStatePath).toBeUndefined();
  }, 30_000);

  it("offers a storage-state path step when the operator says the app requires sign-in, and rejects a missing file", async () => {
    const { stdin, lastFrame } = render(
      <MapDiscoverScreen runtime={runtime} onComplete={() => {}} onCancel={() => {}} />,
    );

    await typeAndSubmit(stdin, baseUrl);
    await clearAndType(stdin, "Demo Shop");
    await pressEnter(stdin);

    expect(lastFrame() ?? "").toContain("require sign-in");
    stdin.write("\u001B[B"); // move down to "Yes — use a session saved via `nova login`"
    await settle();
    await pressEnter(stdin);

    expect(lastFrame() ?? "").toContain("Session file saved by");
    const missingPath = join(tempDir, "does-not-exist.json");
    await typeAndSubmit(stdin, missingPath);

    expect(lastFrame() ?? "").toContain("No file found");
  }, 15_000);

  it("reaches the confirm step with a real storage-state path and passes it through to the drafted map", async () => {
    let completedMapId: string | undefined;
    const storageStatePath = join(tempDir, "session.json");
    writeFileSync(storageStatePath, JSON.stringify({ cookies: [], origins: [] }));

    const { stdin, lastFrame } = render(
      <MapDiscoverScreen
        runtime={runtime}
        onComplete={(map) => {
          completedMapId = map.id;
        }}
        onCancel={() => {}}
      />,
    );

    await typeAndSubmit(stdin, baseUrl);
    await clearAndType(stdin, "Demo Shop");
    await pressEnter(stdin);
    stdin.write("\u001B[B");
    await settle();
    await pressEnter(stdin);
    await typeAndSubmit(stdin, storageStatePath);

    expect(lastFrame() ?? "").toContain("signed in via");
    // The terminal frame wraps a long path across border-drawn lines, so
    // assert on a distinctive fragment rather than the full contiguous
    // string.
    expect(lastFrame() ?? "").toContain("session.json");
    await pressEnter(stdin);

    const draftDeadline = Date.now() + 20_000;
    while (!(lastFrame() ?? "").includes("MAP DRAFTED") && Date.now() < draftDeadline) {
      await settle(200);
    }
    expect(lastFrame() ?? "").toContain("MAP DRAFTED");
    await pressEnter(stdin);

    expect(completedMapId).toBeDefined();
    const saved = runtime.testMaps.get(completedMapId as string);
    expect(saved?.approvedScope.storageStatePath).toBe(storageStatePath);
  }, 30_000);

  it("Escape cancels and never leaves a partial map behind", async () => {
    let cancelled = false;
    const { stdin } = render(
      <MapDiscoverScreen
        runtime={runtime}
        onComplete={() => {
          throw new Error("onComplete should not fire after cancel");
        }}
        onCancel={() => {
          cancelled = true;
        }}
      />,
    );
    stdin.write("\u001B"); // Escape
    await settle();
    expect(cancelled).toBe(true);
    expect(runtime.testMaps.list()).toHaveLength(0);
  });
});
