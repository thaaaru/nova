import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { buildRuntime, type NovaRuntime } from "../../src/cli/context.js";
import { App } from "../../src/tui/app.js";

/**
 * `nova <url>` and `nova test` must land on the guided flow, not on the
 * map menu the operator just asked to skip. This asserts the entry
 * routing at the App level — the piece between the CLI's argv handling
 * (covered in guided-security.test.ts) and TestFlowScreen's own phases.
 */

let tempDir: string;
let runtime: NovaRuntime;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-app-entry-"));
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

async function settle(ms = 80): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

describe("App entry routing", () => {
  it("opens the guided flow when a target is supplied", async () => {
    const { lastFrame, unmount } = render(
      <App runtime={runtime} initialTarget="https://shop.example.test" />,
    );
    await settle();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ENVIRONMENT");
    expect(frame).toContain("shop.example.test");
    expect(frame).not.toContain("Test an application area");
    unmount();
  });

  it("opens the guided flow for `nova test` with no target", async () => {
    const { lastFrame, unmount } = render(<App runtime={runtime} startInGuidedFlow />);
    await settle();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("TARGET");
    expect(frame).not.toContain("Test an application area");
    unmount();
  });

  it("still opens the map home for plain `nova tui`", async () => {
    const { lastFrame, unmount } = render(<App runtime={runtime} />);
    await settle();
    expect(lastFrame() ?? "").toContain("Test an application");
    unmount();
  });
});
