import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

import { buildRuntime, type NovaRuntime } from "../../src/cli/context.js";
import { MapDiscoverScreen } from "../../src/tui/screens/MapDiscoverScreen.js";
import { createProject } from "../../src/services/testmap/project-service.js";

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

// The project-select step always starts on "+ Create a new project" for a
// fresh runtime with no projects yet — pressing Enter selects it, exactly
// like an operator's first-ever discover.
async function createProjectAndContinue(
  stdin: { write: (data: string) => void },
  name: string,
): Promise<void> {
  await pressEnter(stdin); // select "+ Create a new project"
  await typeAndSubmit(stdin, name);
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
  it("walks target URL -> name -> environment -> auto-detects no auth required -> confirm and drafts a real map from a live target", async () => {
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

    expect(lastFrame() ?? "").toContain("Which project");
    await createProjectAndContinue(stdin, "Demo Project");

    // index.html has no password field/login redirect/401 — the real
    // detectAuthRequirement probe should find nothing to sign in for,
    // never asking the operator a blind "does this need sign-in?"
    // question.
    await typeAndSubmit(stdin, baseUrl);

    expect(lastFrame() ?? "").toContain("Application name");
    await clearAndType(stdin, "Demo Shop");

    expect(lastFrame() ?? "").toContain("Environment");
    await pressEnter(stdin); // accept the pre-selected environment

    // The probe is genuinely asynchronous, so the "checking…" frame is
    // transient: on a warm machine it can resolve before this assertion
    // ever observes it. What matters is that the screen is either still
    // probing or already past it — never stuck asking the operator a
    // blind "does this need sign-in?" question.
    const afterEnvironment = lastFrame() ?? "";
    expect(
      afterEnvironment.includes("Checking whether sign-in is required") ||
        afterEnvironment.includes("Add to project"),
    ).toBe(true);

    // The auth probe is a real headless browser navigation — poll for
    // it to resolve instead of a fixed sleep.
    const authProbeDeadline = Date.now() + 15_000;
    while (!(lastFrame() ?? "").includes("Add to project") && Date.now() < authProbeDeadline) {
      await settle(200);
    }
    await settle();
    expect(lastFrame() ?? "").toContain("Add to project");
    expect(lastFrame() ?? "").not.toContain("persona");
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
    await settle();
    expect(lastFrame() ?? "").toContain("MAP DRAFTED");
    await pressEnter(stdin);

    expect(completedMap).toBe("Demo Shop");
    const savedMaps = runtime.testMaps.list();
    expect(savedMaps).toHaveLength(1);
    expect(savedMaps[0]?.approvedScope.storageStatePath).toBeUndefined();
    expect(savedMaps[0]?.approvedScope.personaId).toBeUndefined();
  }, 30_000);

  it("auto-detects a sign-in wall and offers the persona sub-flow, rejecting an empty persona name", async () => {
    const { stdin, lastFrame } = render(
      <MapDiscoverScreen runtime={runtime} onComplete={() => {}} onCancel={() => {}} />,
    );

    await createProjectAndContinue(stdin, "Demo Project");
    // login.html has a password field, one button, and no links — the
    // real probe's landing-page heuristic should classify it as
    // requiring sign-in without the operator ever being asked upfront.
    await typeAndSubmit(stdin, `${baseUrl}/login.html`);
    await clearAndType(stdin, "Demo Shop");
    await pressEnter(stdin);

    const authProbeDeadline = Date.now() + 15_000;
    while (!(lastFrame() ?? "").includes("Authentication required") && Date.now() < authProbeDeadline) {
      await settle(200);
    }
    await settle();
    expect(lastFrame() ?? "").toContain("Authentication required");
    expect(lastFrame() ?? "").toContain("Sign in in browser now");
    expect(lastFrame() ?? "").toContain("Enter test-account reference");
    expect(lastFrame() ?? "").toContain("Continue without signing in");

    stdin.write("\u001B[B"); // move down to "Enter test-account reference"
    await settle();
    await pressEnter(stdin);

    expect(lastFrame() ?? "").toContain("Name this test-account persona");
    await typeAndSubmit(stdin, "");
    expect(lastFrame() ?? "").toContain("Enter a name for this persona");
  }, 20_000);

  it("captures a persona via a real headed-browser sign-in and reuses it on the drafted map, never exposing a raw path", async () => {
    let completedMapId: string | undefined;
    const { stdin, lastFrame } = render(
      <MapDiscoverScreen
        runtime={runtime}
        onComplete={(map) => {
          completedMapId = map.id;
        }}
        onCancel={() => {}}
      />,
    );

    await createProjectAndContinue(stdin, "Demo Project");
    await typeAndSubmit(stdin, `${baseUrl}/login.html`);
    await clearAndType(stdin, "Demo Shop");
    await pressEnter(stdin);

    const authProbeDeadline = Date.now() + 15_000;
    while (!(lastFrame() ?? "").includes("Authentication required") && Date.now() < authProbeDeadline) {
      await settle(200);
    }
    await settle();
    expect(lastFrame() ?? "").toContain("+ Sign in in browser now");
    await pressEnter(stdin); // "+ Sign in in browser now" is the first item

    expect(lastFrame() ?? "").toContain("Name this persona");
    await typeAndSubmit(stdin, "QA Admin");

    // The real headed-browser capture waits for an operator Enter —
    // give the headed browser a moment to open before confirming.
    const openDeadline = Date.now() + 10_000;
    while (!(lastFrame() ?? "").includes("Sign in in the browser window") && Date.now() < openDeadline) {
      await settle(200);
    }
    await settle();
    expect(lastFrame() ?? "").toContain("Sign in in the browser window");
    await pressEnter(stdin); // "I'm signed in — capture this session"

    const confirmDeadline = Date.now() + 10_000;
    while (!(lastFrame() ?? "").includes("Add to project") && Date.now() < confirmDeadline) {
      await settle(200);
    }
    await settle();
    // The confirm line wraps across border-drawn lines for a target
    // this long, so assert on distinctive fragments rather than one
    // contiguous phrase.
    expect(lastFrame() ?? "").toContain("persona");
    expect(lastFrame() ?? "").toContain("QA Admin");
    // The path/cookie mechanics are never surfaced to the operator.
    expect(lastFrame() ?? "").not.toContain(".json");
    expect(lastFrame() ?? "").not.toContain("vault");
    await pressEnter(stdin);

    const draftDeadline = Date.now() + 20_000;
    while (!(lastFrame() ?? "").includes("MAP DRAFTED") && Date.now() < draftDeadline) {
      await settle(200);
    }
    await settle();
    expect(lastFrame() ?? "").toContain("MAP DRAFTED");
    await pressEnter(stdin);

    expect(completedMapId).toBeDefined();
    const saved = runtime.testMaps.get(completedMapId as string);
    expect(saved?.approvedScope.personaId).toBeDefined();
    expect(saved?.approvedScope.storageStatePath).toBeDefined();
    // The map's own approvedScope holds a plain local session copy path
    // (chmod 600, same trust model discovery/execution already used);
    // the persona's own vault entry is the encrypted one.
    const personas = runtime.personas.list(runtime.testMaps.list()[0]?.projectId as string);
    expect(personas).toHaveLength(1);
    expect(personas[0]?.name).toBe("QA Admin");
    expect(personas[0]?.sessionStatus).toBe("ready");
    expect(personas[0]?.vaultRef).toBeDefined();
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

  it("skips the project step entirely when launched with a presetProjectId — e.g. 'New app' inside an already-selected project", async () => {
    const project = createProject(runtime, { name: "Preset Project" });
    const { lastFrame } = render(
      <MapDiscoverScreen
        runtime={runtime}
        presetProjectId={project.id}
        onComplete={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(lastFrame() ?? "").not.toContain("Which project");
    expect(lastFrame() ?? "").toContain("Target URL");
  });
});
