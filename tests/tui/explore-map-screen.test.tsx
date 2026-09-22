import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

import { buildRuntime, type NovaRuntime } from "../../src/cli/context.js";
import { ExploreMapScreen } from "../../src/tui/screens/ExploreMapScreen.js";
import { sampleApplicationTestMap } from "../../fixtures/sample-application-test-map.js";

let tempDir: string;
let runtime: NovaRuntime;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-explore-map-screen-test-"));
  runtime = buildRuntime({
    databasePath: join(tempDir, "nova.sqlite"),
    artifactsDirectory: join(tempDir, "artifacts"),
    headless: true,
  });
});

afterEach(() => {
  runtime.repository.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function settle(ms = 50): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

describe("ExploreMapScreen", () => {
  it("runs an approved journey directly on Enter, without forcing the operator back through Home", async () => {
    const onSelectJourney = vi.fn();
    const { stdin } = render(
      <ExploreMapScreen
        runtime={runtime}
        map={sampleApplicationTestMap}
        onMapChanged={() => {}}
        onSelectJourney={onSelectJourney}
        onBack={() => {}}
      />,
    );

    // Row 0 is the "Authentication" area header; row 1 is its first
    // journey, "login_standard_customer" — already approved in the
    // fixture.
    stdin.write("\u001B[B");
    await settle();
    stdin.write("\r");
    await settle();

    expect(onSelectJourney).toHaveBeenCalledWith("authentication", "login_standard_customer");
  });

  it("does nothing on Enter for a draft journey — approve it with 'A' first", async () => {
    const onSelectJourney = vi.fn();
    const { stdin } = render(
      <ExploreMapScreen
        runtime={runtime}
        map={sampleApplicationTestMap}
        onMapChanged={() => {}}
        onSelectJourney={onSelectJourney}
        onBack={() => {}}
      />,
    );

    // Row 5 is "product_search_and_filter" under "Product Catalogue" —
    // deliberately left in draft status by the fixture.
    for (let index = 0; index < 5; index += 1) {
      stdin.write("\u001B[B");
      await settle(10);
    }
    stdin.write("\r");
    await settle();

    expect(onSelectJourney).not.toHaveBeenCalled();
  });
});
