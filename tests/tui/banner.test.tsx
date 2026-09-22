import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { buildRuntime, type NovaRuntime } from "../../src/cli/context.js";
import { App } from "../../src/tui/app.js";
import { Banner, shouldShowBanner } from "../../src/tui/components/Banner.js";

describe("Banner", () => {
  it("renders the full wordmark and tagline at normal width", () => {
    const { lastFrame } = render(<Banner columns={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Discover");
    expect(frame).toContain("Approve");
    expect(frame).toContain("Execute");
  });

  it("renders the compact one-line form below 50 columns", () => {
    const { lastFrame } = render(<Banner columns={40} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NOVA | Discover > Approve > Execute");
  });
});

describe("shouldShowBanner", () => {
  it("shows for a plain interactive TTY session", () => {
    expect(shouldShowBanner({ isTTY: true })).toBe(true);
  });

  it("suppresses for non-TTY sessions", () => {
    expect(shouldShowBanner({ isTTY: false })).toBe(false);
  });

  it("suppresses when --no-banner is passed", () => {
    expect(shouldShowBanner({ isTTY: true, noBanner: true })).toBe(false);
  });

  it("suppresses in CI", () => {
    expect(shouldShowBanner({ isTTY: true, ci: true })).toBe(false);
  });

  it("suppresses for JSON output mode", () => {
    expect(shouldShowBanner({ isTTY: true, json: true })).toBe(false);
  });
});

// ink-testing-library's stdin write is delivered through Node's real event
// loop (Ink's `useInput` subscription reads process.stdin asynchronously) —
// see tests/tui/settings-and-verbosity-cycle.test.tsx for the same pattern.
async function settle(ms = 50): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

describe("App startup banner dismissal", () => {
  let tempDir: string;
  let runtime: NovaRuntime;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nova-banner-test-"));
    runtime = buildRuntime({
      databasePath: join(tempDir, "nova.sqlite"),
      artifactsDirectory: join(tempDir, "artifacts"),
      headless: true,
    });
  });

  afterEach(() => {
    runtime.repository.close();
    runtime.testMaps.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("ignores a keystroke buffered before mount so the banner stays visible on first paint", async () => {
    const { stdin, lastFrame, unmount } = render(<App runtime={runtime} showBanner={true} />);
    // Simulates the leftover Enter from the shell command that launched
    // the process landing on stdin the instant raw-mode input attaches.
    stdin.write("\r");
    await settle(10);
    expect(lastFrame() ?? "").toContain("Discover > Approve > Execute");
    unmount();
  });

  it("dismisses on a genuine keystroke once the guard window has elapsed", async () => {
    const { stdin, lastFrame, unmount } = render(<App runtime={runtime} showBanner={true} />);
    await settle(250);
    stdin.write("\r");
    await settle(10);
    expect(lastFrame() ?? "").not.toContain("Discover > Approve > Execute");
    unmount();
  });

  it("never mounts the banner when showBanner is false", async () => {
    const { lastFrame, unmount } = render(<App runtime={runtime} showBanner={false} />);
    await settle(10);
    expect(lastFrame() ?? "").not.toContain("Discover > Approve > Execute");
    unmount();
  });
});
