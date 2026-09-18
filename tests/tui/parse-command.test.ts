import { describe, expect, it } from "vitest";

import { parseCommand } from "../../src/tui/command-mode/parse-command.js";
import { suggestCommands } from "../../src/tui/command-mode/command-specs.js";

describe("parseCommand", () => {
  it("parses :help", () => {
    expect(parseCommand(":help")).toEqual({ ok: true, name: "help", args: {} });
  });

  it("parses :status, :runs, :pause, :resume, :stop, :json, :clear with no args", () => {
    for (const name of ["status", "runs", "pause", "resume", "stop", "json", "clear"]) {
      expect(parseCommand(`:${name}`)).toEqual({ ok: true, name, args: {} });
    }
  });

  it("parses :discover --target <url>", () => {
    expect(parseCommand(":discover --target https://shop.example.test/")).toEqual({
      ok: true,
      name: "discover",
      args: { target: "https://shop.example.test/" },
    });
  });

  it("rejects :discover with a malformed URL", () => {
    const result = parseCommand(":discover --target not-a-url");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not a valid URL/);
  });

  it("rejects :discover missing --target", () => {
    const result = parseCommand(":discover");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/requires --target/);
  });

  it('parses :plan --objective "<text>" preserving spaces inside quotes', () => {
    expect(parseCommand(':plan --objective "check the checkout flow"')).toEqual({
      ok: true,
      name: "plan",
      args: { objective: "check the checkout flow" },
    });
  });

  it("parses :approve --plan <plan-id>", () => {
    expect(parseCommand(":approve --plan run-123")).toEqual({
      ok: true,
      name: "approve",
      args: { plan: "run-123" },
    });
  });

  it("parses :run --plan <plan-id>", () => {
    expect(parseCommand(":run --plan run-123")).toEqual({ ok: true, name: "run", args: { plan: "run-123" } });
  });

  it("parses :report --run <run-id>", () => {
    expect(parseCommand(":report --run run-123")).toEqual({
      ok: true,
      name: "report",
      args: { run: "run-123" },
    });
  });

  it("parses :artifacts --run <run-id>", () => {
    expect(parseCommand(":artifacts --run run-123")).toEqual({
      ok: true,
      name: "artifacts",
      args: { run: "run-123" },
    });
  });

  it("parses :verbosity executive|standard|diagnostic", () => {
    for (const level of ["executive", "standard", "diagnostic"]) {
      expect(parseCommand(`:verbosity ${level}`)).toEqual({ ok: true, name: "verbosity", args: { level } });
    }
  });

  it("rejects an invalid :verbosity value", () => {
    const result = parseCommand(":verbosity loud");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/must be one of/);
  });

  it("parses :animation on|off", () => {
    expect(parseCommand(":animation on")).toEqual({ ok: true, name: "animation", args: { value: "on" } });
    expect(parseCommand(":animation off")).toEqual({ ok: true, name: "animation", args: { value: "off" } });
  });

  it("rejects an invalid :animation value", () => {
    const result = parseCommand(":animation maybe");
    expect(result.ok).toBe(false);
  });

  it("produces a readable error for an unknown command", () => {
    const result = parseCommand(":frobnicate");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Unknown command ":frobnicate"/);
  });

  it("produces a readable error for an empty command", () => {
    const result = parseCommand(":");
    expect(result.ok).toBe(false);
  });

  it("tolerates a missing leading colon", () => {
    expect(parseCommand("help")).toEqual({ ok: true, name: "help", args: {} });
  });
});

describe("suggestCommands", () => {
  it("returns every command name for an empty prefix", () => {
    expect(suggestCommands("")).toContain("discover");
    expect(suggestCommands("")).toContain("help");
  });

  it("prefix-matches command names, case-insensitively, ignoring a leading colon", () => {
    expect(suggestCommands(":dis")).toEqual(["discover"]);
    expect(suggestCommands("REP")).toEqual(["report"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(suggestCommands("zzz")).toEqual([]);
  });
});
