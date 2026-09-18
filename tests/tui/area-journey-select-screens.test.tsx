import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { sampleApplicationTestMap } from "../../fixtures/sample-application-test-map.js";
import { AreaSelectScreen } from "../../src/tui/screens/AreaSelectScreen.js";
import { JourneySelectScreen } from "../../src/tui/screens/JourneySelectScreen.js";

const noop = (): void => {
  // intentionally empty — these tests only assert on rendered frames.
};

describe("AreaSelectScreen", () => {
  it("renders every area with its risk level and recent-failure count", () => {
    const { lastFrame } = render(
      <AreaSelectScreen map={sampleApplicationTestMap} onSelect={noop} onBack={noop} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Checkout");
    expect(frame).toContain("high risk");
    expect(frame).toContain("recent failure(s)");
  });
});

describe("JourneySelectScreen", () => {
  it("renders each journey's mode, risk level, and last run outcome for the checkout area", () => {
    const { lastFrame } = render(
      <JourneySelectScreen map={sampleApplicationTestMap} areaId="checkout" onSelect={noop} onBack={noop} />,
    );
    const frame = (lastFrame() ?? "").replace(/[│┌┐└┘─╭╮╰╯❯]/g, " ").replace(/\s+/g, " ");
    expect(frame).toContain("Registered customer checkout");
    expect(frame).toContain("Controlled test");
    expect(frame).toContain("high risk");
    expect(frame).toContain("last run: failed");
  });
});
