import { describe, expect, it } from "vitest";

import type { RunEvent } from "../../src/domain/index.js";
import { filterEventsByVerbosity } from "../../src/tui/services/verbosity.js";

function event(minVerbosity: RunEvent["minVerbosity"], message: string): RunEvent {
  return {
    id: message,
    timestamp: "2024-01-01T00:00:00.000Z",
    stage: "execute",
    level: "info",
    minVerbosity,
    message,
    detail: {},
  };
}

describe("filterEventsByVerbosity", () => {
  const events = [
    event("executive", "policy blocked a case"),
    event("standard", "case-1 completed"),
    event("diagnostic", "locator resolved via role+name"),
  ];

  it("shows only executive-level events at executive verbosity", () => {
    expect(filterEventsByVerbosity(events, "executive").map((e) => e.message)).toEqual([
      "policy blocked a case",
    ]);
  });

  it("shows executive and standard events at standard verbosity", () => {
    expect(filterEventsByVerbosity(events, "standard").map((e) => e.message)).toEqual([
      "policy blocked a case",
      "case-1 completed",
    ]);
  });

  it("shows every event at diagnostic verbosity", () => {
    expect(filterEventsByVerbosity(events, "diagnostic").map((e) => e.message)).toEqual([
      "policy blocked a case",
      "case-1 completed",
      "locator resolved via role+name",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(filterEventsByVerbosity([], "diagnostic")).toEqual([]);
  });
});
