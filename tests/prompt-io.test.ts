import { describe, expect, it } from "vitest";

import { createPromptSession, moveSelection, parseRawKeys } from "../src/cli/interactive/prompt-io.js";
import { mockPromptIO } from "./support/mock-prompt-io.js";

describe("moveSelection", () => {
  it("wraps forward past the last choice back to the first", () => {
    expect(moveSelection(2, "down", 3)).toBe(0);
  });

  it("wraps backward past the first choice back to the last", () => {
    expect(moveSelection(0, "up", 3)).toBe(2);
  });

  it("steps by one within bounds", () => {
    expect(moveSelection(0, "down", 3)).toBe(1);
    expect(moveSelection(1, "up", 3)).toBe(0);
  });
});

describe("parseRawKeys", () => {
  it("recognizes a full arrow sequence delivered in one chunk", () => {
    expect(parseRawKeys("\u001b[A")).toEqual({ keys: ["up"], rest: "" });
    expect(parseRawKeys("\u001b[B")).toEqual({ keys: ["down"], rest: "" });
  });

  it("recognizes enter and Ctrl+C", () => {
    expect(parseRawKeys("\r")).toEqual({ keys: ["enter"], rest: "" });
    expect(parseRawKeys("\u0003")).toEqual({ keys: ["cancel"], rest: "" });
  });

  it("reads multiple keys queued in a single chunk in order", () => {
    expect(parseRawKeys("\u001b[B\u001b[B\r")).toEqual({ keys: ["down", "down", "enter"], rest: "" });
  });

  it("buffers a lone ESC byte until enough bytes arrive to disambiguate it", () => {
    const first = parseRawKeys("\u001b");
    expect(first).toEqual({ keys: [], rest: "\u001b" });
    const second = parseRawKeys(`${first.rest}[A`);
    expect(second).toEqual({ keys: ["up"], rest: "" });
  });

  it("ignores unrecognized bytes (e.g. printable characters) during arrow navigation", () => {
    expect(parseRawKeys("q\r")).toEqual({ keys: ["enter"], rest: "" });
  });
});

describe("createPromptSession — arrow-key select on a raw-capable terminal", () => {
  it("moves the highlight with down/up and selects the highlighted choice on Enter", async () => {
    const { io, transcript } = mockPromptIO([], { raw: true });
    const session = createPromptSession(io);

    const resultPromise = session.select(
      "Pick one",
      [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
        { label: "Gamma", value: "gamma" },
      ],
      "alpha",
    );

    io.input.push("\u001b[B");
    io.input.push("\u001b[B");
    io.input.push("\r");

    const result = await resultPromise;
    expect(result).toBe("gamma");
    expect(transcript()).toContain("Pick one:");
    expect(transcript()).toContain("Gamma");
  });

  it("cancels on Ctrl+C without requiring a numbered answer", async () => {
    const { io } = mockPromptIO([], { raw: true });
    const session = createPromptSession(io);

    const resultPromise = session.select("Pick one", [
      { label: "Alpha", value: "alpha" },
      { label: "Beta", value: "beta" },
    ]);

    io.input.push("\u0003");

    const result = await resultPromise;
    expect(result).toBeUndefined();
  });

  it("restores line mode afterward so a following text prompt still works", async () => {
    const { io } = mockPromptIO([], { raw: true });
    const session = createPromptSession(io);

    const selectPromise = session.select(
      "Pick one",
      [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
      ],
      "alpha",
    );
    io.input.push("\r");
    expect(await selectPromise).toBe("alpha");

    const linePromise = session.line("Name");
    io.input.push("Ada\n");
    expect(await linePromise).toBe("Ada");
  });

  it("falls back to numbered entry when the stream cannot be switched to raw mode", async () => {
    const { io, transcript } = mockPromptIO(["2"]);
    const session = createPromptSession(io);

    const result = await session.select("Pick one", [
      { label: "Alpha", value: "alpha" },
      { label: "Beta", value: "beta" },
    ]);

    expect(result).toBe("beta");
    expect(transcript()).toContain("Enter a number");
  });
});
