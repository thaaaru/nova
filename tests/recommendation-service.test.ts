import { describe, expect, it } from "vitest";

import { recommendRegressionJourneys } from "../src/services/testmap/recommendation-service.js";
import { sampleApplicationTestMap } from "../fixtures/sample-application-test-map.js";

// Anchored to the same instant the fixture's "recent" vs. "stale" timestamps
// were written against, so staleness is deterministic regardless of when
// the suite actually runs.
const NOW = new Date("2026-09-18T00:00:00.000Z");

describe("recommendRegressionJourneys against the seeded map", () => {
  it("recommends the journey whose last run failed", async () => {
    const recommendations = await recommendRegressionJourneys(
      sampleApplicationTestMap,
      undefined,
      undefined,
      NOW,
    );
    const failed = recommendations.find(
      (recommendation) => recommendation.journeyId === "invalid_payment_handling",
    );
    expect(failed).toBeDefined();
    expect(failed?.reason).toBe("Last run failed");
  });

  it("recommends the journey whose last run was flaky", async () => {
    const recommendations = await recommendRegressionJourneys(
      sampleApplicationTestMap,
      undefined,
      undefined,
      NOW,
    );
    const flaky = recommendations.find(
      (recommendation) => recommendation.journeyId === "update_cart_quantity",
    );
    expect(flaky).toBeDefined();
    expect(flaky?.reason).toBe("Recently flaky");
  });

  it("recommends a passed journey that hasn't run in over the stale threshold", async () => {
    const recommendations = await recommendRegressionJourneys(
      sampleApplicationTestMap,
      undefined,
      undefined,
      NOW,
    );
    const stale = recommendations.find(
      (recommendation) => recommendation.journeyId === "browse_product_catalogue",
    );
    expect(stale).toBeDefined();
    expect(stale?.reason).toMatch(/Not run in \d+ days/);
  });

  it("does not recommend a recently-passed, non-stale journey", async () => {
    const recommendations = await recommendRegressionJourneys(
      sampleApplicationTestMap,
      undefined,
      undefined,
      NOW,
    );
    expect(recommendations.some((recommendation) => recommendation.journeyId === "add_to_cart")).toBe(false);
  });

  it("sorts high-risk recommendations before lower-risk ones", async () => {
    const recommendations = await recommendRegressionJourneys(
      sampleApplicationTestMap,
      undefined,
      undefined,
      NOW,
    );
    const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const observedOrder = recommendations.map((recommendation) => riskOrder[recommendation.riskLevel]);
    expect(observedOrder).toEqual([...observedOrder].sort((a, b) => a - b));

    const failedIndex = recommendations.findIndex(
      (recommendation) => recommendation.journeyId === "invalid_payment_handling",
    );
    const staleIndex = recommendations.findIndex(
      (recommendation) => recommendation.journeyId === "browse_product_catalogue",
    );
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(staleIndex).toBeGreaterThan(failedIndex);
  });
});
