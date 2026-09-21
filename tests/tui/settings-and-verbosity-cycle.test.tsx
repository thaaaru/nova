import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

import type { NovaConfig } from "../../src/config/index.js";
import { loadTuiSettings, saveTuiSettings } from "../../src/tui/theme/settings.js";
import { buildMapHomeSummary } from "../../src/tui/services/testmap-view-model.js";
import { MapHomeScreen } from "../../src/tui/screens/MapHomeScreen.js";

let tempDir: string;
let config: NovaConfig;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-settings-test-"));
  config = {
    databasePath: join(tempDir, "nova.sqlite"),
    artifactsDirectory: join(tempDir, "artifacts"),
    headless: true,
  } as NovaConfig;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("saveTuiSettings / loadTuiSettings round-trip", () => {
  it("persists a diagnostic-verbosity, animation-off preference and reads it back unchanged", () => {
    saveTuiSettings(config, { verbosity: "diagnostic", animation: false });
    const loaded = loadTuiSettings(config);
    expect(loaded).toEqual({ verbosity: "diagnostic", animation: false });
  });

  it("falls back to defaults for a database path with no settings file yet written", () => {
    expect(loadTuiSettings(config)).toEqual({ verbosity: "standard", animation: true });
  });

  it("round-trips every verbosity level independently of animation", () => {
    for (const verbosity of ["executive", "standard", "diagnostic"] as const) {
      saveTuiSettings(config, { verbosity, animation: true });
      expect(loadTuiSettings(config)).toEqual({ verbosity, animation: true });
    }
  });
});

// ink-testing-library's stdin write is delivered through Node's real
// event loop (Ink's `useInput` subscription reads process.stdin
// asynchronously) — a fake-timer clock never observes it, so this
// integration test needs a genuine tick, exactly like every other
// stdin-driving TUI test in this repo (see map-discover-screen.test.tsx).
async function settle(ms = 50): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

describe("MapHomeScreen verbosity cycling", () => {
  it("calls onCycleVerbosity when 'v' is pressed", async () => {
    const onCycleVerbosity = vi.fn();
    const { stdin, unmount } = render(
      <MapHomeScreen
        summary={buildMapHomeSummary(undefined)}
        onSelect={() => undefined}
        onQuit={() => undefined}
        onCycleVerbosity={onCycleVerbosity}
      />,
    );
    stdin.write("v");
    await settle();
    expect(onCycleVerbosity).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("calls onCycleVerbosity when 'V' (uppercase) is pressed", async () => {
    const onCycleVerbosity = vi.fn();
    const { stdin, unmount } = render(
      <MapHomeScreen
        summary={buildMapHomeSummary(undefined)}
        onSelect={() => undefined}
        onQuit={() => undefined}
        onCycleVerbosity={onCycleVerbosity}
      />,
    );
    stdin.write("V");
    await settle();
    expect(onCycleVerbosity).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("never calls onCycleVerbosity while inputActive is false (the `:`-mode command bar owns the keyboard)", async () => {
    const onCycleVerbosity = vi.fn();
    const { stdin, unmount } = render(
      <MapHomeScreen
        summary={buildMapHomeSummary(undefined)}
        onSelect={() => undefined}
        onQuit={() => undefined}
        onCycleVerbosity={onCycleVerbosity}
        inputActive={false}
      />,
    );
    stdin.write("v");
    await settle();
    expect(onCycleVerbosity).not.toHaveBeenCalled();
    unmount();
  });
});
