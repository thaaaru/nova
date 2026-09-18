import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import type { NovaRuntime } from "../../src/cli/context.js";
import { sampleApplicationTestMap } from "../../fixtures/sample-application-test-map.js";
import { DescribeTestScreen } from "../../src/tui/screens/DescribeTestScreen.js";

const noop = (): void => {
  // intentionally empty — these tests only assert on rendered frames.
};

// describeTest (via mapService) only ever reads `runtime.testMaps.get` —
// this stand-in supplies exactly that, keeping the test off a real
// SQLite-backed runtime.
function fakeRuntime(): NovaRuntime {
  return {
    testMaps: {
      get: (mapId: string) => (mapId === sampleApplicationTestMap.id ? sampleApplicationTestMap : undefined),
    },
  } as unknown as NovaRuntime;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

describe("DescribeTestScreen", () => {
  it("renders the matched journey name when the request scores above the match threshold", async () => {
    const { lastFrame, stdin } = render(
      <DescribeTestScreen
        runtime={fakeRuntime()}
        map={sampleApplicationTestMap}
        onProceedToMatch={noop}
        onBack={noop}
      />,
    );
    stdin.write("Guest checkout without creating an account");
    await delay(10);
    stdin.write("\r");
    await delay(10);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("This matches an existing test:");
    expect(frame).toContain("Guest checkout");
    expect(frame).toContain("Checkout");
  });

  it("renders the draft-outline copy and offers no run action when nothing matches closely", async () => {
    const { lastFrame, stdin } = render(
      <DescribeTestScreen
        runtime={fakeRuntime()}
        map={sampleApplicationTestMap}
        onProceedToMatch={noop}
        onBack={noop}
      />,
    );
    stdin.write("Verify the loyalty points widget renders on the homepage footer");
    await delay(10);
    stdin.write("\r");
    await delay(10);
    const frame = (lastFrame() ?? "").replace(/[│┌┐└┘─╭╮╰╯]/g, " ").replace(/\s+/g, " ");
    expect(frame).toContain("Nova has drafted a guided test outline");
    expect(frame).not.toContain("This matches an existing test:");
    expect(frame).not.toContain("Continue to pre-run summary");
  });
});
