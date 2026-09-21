import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/index.js";
import { loadTuiSettings } from "../src/tui/theme/settings.js";

// `nova config set` (src/cli/index.ts) is the CLI's own path onto exactly
// the settings file `:animation`/`:verbosity` write inside the TUI (see
// src/tui/theme/settings.ts) — driven here through the real built CLI,
// the same subprocess-driving pattern tests/apply-update.test.ts uses,
// reading the persisted file back with the same loadTuiSettings the TUI
// itself reads with.

let tempDir: string;
let databasePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-config-set-test-"));
  databasePath = join(tempDir, "nova.sqlite");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

type NovaCliResult = { status: number; stdout: string; stderr: string };

function runNova(args: string[]): NovaCliResult {
  try {
    const stdout = execFileSync("node_modules/.bin/tsx", ["src/cli/index.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NOVA_NO_UPDATE_CHECK: "1", NOVA_DATABASE_PATH: databasePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 1;
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    return { status, stdout, stderr };
  }
}

describe("nova config set", () => {
  it("`config set animation off` persists to the real settings file and is readable back via loadTuiSettings", () => {
    const result = runNova(["config", "set", "animation", "off"]);
    expect(result.status).toBe(0);

    const config = loadConfig({ databasePath });
    expect(loadTuiSettings(config)).toEqual({ verbosity: "standard", animation: false });
  }, 20000);

  it("`config set verbosity diagnostic` persists to the real settings file and is readable back via loadTuiSettings", () => {
    const result = runNova(["config", "set", "verbosity", "diagnostic"]);
    expect(result.status).toBe(0);

    const config = loadConfig({ databasePath });
    expect(loadTuiSettings(config)).toEqual({ verbosity: "diagnostic", animation: true });
  }, 20000);

  it("`config set` preserves an already-set preference when a different key is set afterward", () => {
    runNova(["config", "set", "animation", "off"]);
    runNova(["config", "set", "verbosity", "executive"]);

    const config = loadConfig({ databasePath });
    expect(loadTuiSettings(config)).toEqual({ verbosity: "executive", animation: false });
  }, 20000);

  it("`config set bogus off` exits 1 with a clear stderr message and never writes a settings file", () => {
    const result = runNova(["config", "set", "bogus", "off"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown config key: "bogus"');

    const config = loadConfig({ databasePath });
    expect(loadTuiSettings(config)).toEqual({ verbosity: "standard", animation: true });
  }, 20000);

  it("`config set animation notabool` exits 1 with a clear stderr message and never writes a settings file", () => {
    const result = runNova(["config", "set", "animation", "notabool"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid value for "animation"');

    const config = loadConfig({ databasePath });
    expect(loadTuiSettings(config)).toEqual({ verbosity: "standard", animation: true });
  }, 20000);

  it("`config set verbosity loud` exits 1 with a clear stderr message and never writes a settings file", () => {
    const result = runNova(["config", "set", "verbosity", "loud"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid value for "verbosity"');

    const config = loadConfig({ databasePath });
    expect(loadTuiSettings(config)).toEqual({ verbosity: "standard", animation: true });
  }, 20000);
});
