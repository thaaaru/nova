import { describe, expect, it } from "vitest";

import { matchNaturalLanguageRequest, MATCH_THRESHOLD } from "../src/services/testmap/nl-match-service.js";
import { sampleApplicationTestMap } from "../fixtures/sample-application-test-map.js";

describe("matchNaturalLanguageRequest", () => {
  it("matches a request closely overlapping an existing checkout journey's own name/description", () => {
    const match = matchNaturalLanguageRequest(
      sampleApplicationTestMap,
      "Test coupon discount calculation when applying a coupon code",
    );

    expect(match.kind).toBe("matched");
    if (match.kind === "matched") {
      expect(match.journey.id).toBe("coupon_discount_calculation");
      expect(match.area.id).toBe("checkout");
      expect(match.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    }
  });

  it("matches a request overlapping the registered customer checkout journey", () => {
    const match = matchNaturalLanguageRequest(
      sampleApplicationTestMap,
      "Registered customer checkout completes an order",
    );

    expect(match.kind).toBe("matched");
    if (match.kind === "matched") {
      expect(match.journey.id).toBe("registered_customer_checkout");
      expect(match.score).toBeGreaterThan(0);
    }
  });

  it("returns a draft proposal for a request with no meaningful keyword overlap", () => {
    const match = matchNaturalLanguageRequest(
      sampleApplicationTestMap,
      "quantum flux capacitor recalibration",
    );

    expect(match.kind).toBe("draft");
    if (match.kind === "draft") {
      expect(match.bestScore).toBeLessThan(MATCH_THRESHOLD);
      expect(match.draftJourney.status).toBe("draft");
      expect(match.draftJourney.description).toBe("quantum flux capacitor recalibration");
    }
  });
});
