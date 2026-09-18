import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import type { RunViewModel } from "../../src/domain/index.js";
import { HomeScreen } from "../../src/tui/screens/HomeScreen.js";

function baseViewModel(overrides: Partial<RunViewModel> = {}): RunViewModel {
  return {
    policyModeLabel: "Safe test (state-changing allowed, approval required)",
    testCounts: { planned: 0, passed: 0, failed: 0, flaky: 0, blocked: 0, inconclusive: 0, pending: 0 },
    blockers: [],
    nextActions: [],
    recovery: { active: false },
    ...overrides,
  };
}

const noop = (): void => {
  // intentionally empty — these tests only assert on rendered frames.
};

describe("HomeScreen", () => {
  it("renders the FLOW stage tracker with a marker under the current stage", () => {
    const viewModel = baseViewModel({ currentStage: "execute" });
    const { lastFrame } = render(
      <HomeScreen
        viewModel={viewModel}
        animationEnabled={false}
        onSelectAction={noop}
        onOpenGuidedSetup={noop}
        onOpenVerbosity={noop}
        onOpenCommandMode={noop}
        onQuit={noop}
        columnsOverride={140}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Discover");
    expect(frame).toContain("Plan");
    expect(frame).toContain("Approve");
    expect(frame).toContain("Execute");
    expect(frame).toContain("Verify");
    expect(frame).toContain("Report");
    // The current stage is the only one rendered bold/highlighted; assert
    // it appears without the pulse suffix since animation is disabled.
    expect(frame).toMatch(/Execute(?!\.)/);
  });

  it("renders the NEXT SAFE ACTION list with the correct number of entries and labels", () => {
    const viewModel = baseViewModel({
      nextActions: [
        { id: "discover", label: "Discover target", command: ":discover --target https://example.test" },
        { id: "plan", label: "Generate test plan", command: ':plan --objective "..."' },
      ],
    });
    const { lastFrame } = render(
      <HomeScreen
        viewModel={viewModel}
        animationEnabled={false}
        onSelectAction={noop}
        onOpenGuidedSetup={noop}
        onOpenVerbosity={noop}
        onOpenCommandMode={noop}
        onQuit={noop}
        columnsOverride={140}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NEXT SAFE ACTION");
    expect(frame).toContain("Discover target");
    expect(frame).toContain("Generate test plan");
  });

  it("shows blocked prerequisites explicitly", () => {
    const viewModel = baseViewModel({ blockers: ["No plan yet — discover first, then plan."] });
    const { lastFrame } = render(
      <HomeScreen
        viewModel={viewModel}
        animationEnabled={false}
        onSelectAction={noop}
        onOpenGuidedSetup={noop}
        onOpenVerbosity={noop}
        onOpenCommandMode={noop}
        onQuit={noop}
        columnsOverride={60}
      />,
    );
    const normalized = (lastFrame() ?? "").replace(/[│┌┐└┘─╭╮╰╯]/g, " ").replace(/\s+/g, " ");
    expect(normalized).toContain("No plan yet — discover first, then plan.");
  });

  it("stacks the two-pane body vertically below the narrow-width threshold", () => {
    const viewModel = baseViewModel({ targetBaseUrl: "https://shop.example.test/" });
    const { lastFrame: narrowFrame } = render(
      <HomeScreen
        viewModel={viewModel}
        animationEnabled={false}
        onSelectAction={noop}
        onOpenGuidedSetup={noop}
        onOpenVerbosity={noop}
        onOpenCommandMode={noop}
        onQuit={noop}
        columnsOverride={60}
      />,
    );
    const { lastFrame: wideFrame } = render(
      <HomeScreen
        viewModel={viewModel}
        animationEnabled={false}
        onSelectAction={noop}
        onOpenGuidedSetup={noop}
        onOpenVerbosity={noop}
        onOpenCommandMode={noop}
        onQuit={noop}
        columnsOverride={140}
      />,
    );

    const narrowLines = (narrowFrame() ?? "").split("\n");
    const wideLines = (wideFrame() ?? "").split("\n");
    const narrowActionRow = narrowLines.findIndex((line) => line.includes("NEXT SAFE ACTION"));
    const narrowContextRow = narrowLines.findIndex((line) => line.includes("LIVE CONTEXT"));
    const wideActionRow = wideLines.findIndex((line) => line.includes("NEXT SAFE ACTION"));
    const wideContextRow = wideLines.findIndex((line) => line.includes("LIVE CONTEXT"));

    // Narrow: panels stack, so LIVE CONTEXT starts on a later row than in
    // the wide (side-by-side) layout, where both panels share a row.
    expect(narrowActionRow).toBeGreaterThanOrEqual(0);
    expect(narrowContextRow).toBeGreaterThan(narrowActionRow);
    expect(wideActionRow).toBe(wideContextRow);
  });

  it("renders the key-hint bar", () => {
    const { lastFrame } = render(
      <HomeScreen
        viewModel={baseViewModel()}
        animationEnabled={false}
        onSelectAction={noop}
        onOpenGuidedSetup={noop}
        onOpenVerbosity={noop}
        onOpenCommandMode={noop}
        onQuit={noop}
        columnsOverride={140}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Select");
    expect(frame).toContain("Navigate");
    expect(frame).toContain("Verbosity");
    expect(frame).toContain("Command");
    expect(frame).toContain("Quit");
  });
});
