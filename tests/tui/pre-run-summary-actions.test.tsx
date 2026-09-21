import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import type { NovaRuntime } from "../../src/cli/context.js";
import { sampleApplicationTestMap } from "../../fixtures/sample-application-test-map.js";
import { PreRunSummaryScreen } from "../../src/tui/screens/PreRunSummaryScreen.js";

const noop = (): void => {
  // intentionally empty — these tests only assert on rendered frames.
};

// The screen only touches `runtime` once the operator presses Enter to
// start; these tests assert the summary phase's static bottom-action
// label, so a minimal stand-in is enough and keeps the test from needing
// a real SQLite-backed runtime.
const fakeRuntime = {} as unknown as NovaRuntime;

function findJourney(journeyId: string) {
  const journey = sampleApplicationTestMap.areas
    .flatMap((area) => area.journeys)
    .find((candidate) => candidate.id === journeyId);
  if (!journey) {
    throw new Error(`Fixture journey not found: ${journeyId}`);
  }
  return journey;
}

const context = { environment: sampleApplicationTestMap.environment, fixtureIds: [] };

describe("PreRunSummaryScreen bottom action label", () => {
  it("shows 'Run now' for a quick_test journey", () => {
    const { lastFrame } = render(
      <PreRunSummaryScreen
        runtime={fakeRuntime}
        map={sampleApplicationTestMap}
        journey={findJourney("browse_product_catalogue")}
        context={context}
        verbosity="standard"
        onQuickRunComplete={noop}
        onReadyToConfirm={noop}
        onBack={noop}
      />,
    );
    expect(lastFrame() ?? "").toContain("Run now");
  });

  it("shows 'Review plan' for a guided_test journey", () => {
    const { lastFrame } = render(
      <PreRunSummaryScreen
        runtime={fakeRuntime}
        map={sampleApplicationTestMap}
        journey={findJourney("guest_checkout")}
        context={context}
        verbosity="standard"
        onQuickRunComplete={noop}
        onReadyToConfirm={noop}
        onBack={noop}
      />,
    );
    expect(lastFrame() ?? "").toContain("Review plan");
  });

  it("shows 'Submit for approval' for a controlled_test journey", () => {
    const { lastFrame } = render(
      <PreRunSummaryScreen
        runtime={fakeRuntime}
        map={sampleApplicationTestMap}
        journey={findJourney("registered_customer_checkout")}
        context={context}
        verbosity="standard"
        onQuickRunComplete={noop}
        onReadyToConfirm={noop}
        onBack={noop}
      />,
    );
    expect(lastFrame() ?? "").toContain("Submit for approval");
  });

  it("never offers 'Run now' for a controlled_test journey pre-approval — quick_test's action label is never available on a higher-risk journey", () => {
    const { lastFrame } = render(
      <PreRunSummaryScreen
        runtime={fakeRuntime}
        map={sampleApplicationTestMap}
        journey={findJourney("registered_customer_checkout")}
        context={context}
        verbosity="standard"
        onQuickRunComplete={noop}
        onReadyToConfirm={noop}
        onBack={noop}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("Run now");
  });
});
