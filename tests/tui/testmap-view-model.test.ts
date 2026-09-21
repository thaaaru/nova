import { describe, expect, it } from "vitest";

import { sampleApplicationTestMap } from "../../fixtures/sample-application-test-map.js";
import {
  buildAreaSummaries,
  buildMapHomeMenuItems,
  buildMapHomeSummary,
  estimateJourneyDurationSeconds,
  formatDurationLabel,
  journeyModeLabel,
  journeyRiskLevel,
  preRunActionLabel,
  resolveFirstRequiredPersonaName,
  selectActiveMap,
} from "../../src/tui/services/testmap-view-model.js";

describe("buildMapHomeMenuItems", () => {
  it("offers the seven guided options from the product spec once a map exists", () => {
    expect(buildMapHomeMenuItems(true).map((item) => `${item.number}. ${item.label}`)).toEqual([
      "1. Test an application area",
      "2. Describe a test",
      "3. Run recommended regression tests",
      "4. Explore or update application map",
      "5. Review failures and recoveries",
      "6. Open recent reports",
      "7. Advanced command mode",
    ]);
  });

  it("prepends 'Discover an application' as an empty-state affordance when there is no map yet", () => {
    expect(buildMapHomeMenuItems(false).map((item) => `${item.number}. ${item.label}`)).toEqual([
      "1. Discover an application",
      "2. Test an application area",
      "3. Describe a test",
      "4. Run recommended regression tests",
      "5. Explore or update application map",
      "6. Review failures and recoveries",
      "7. Open recent reports",
      "8. Advanced command mode",
    ]);
  });
});

describe("buildMapHomeSummary", () => {
  it("reports the onboarding message when no map exists", () => {
    const summary = buildMapHomeSummary(undefined);
    expect(summary.hasMap).toBe(false);
    expect(summary.noMapMessage).toContain("nova map discover");
    expect(summary.approvedJourneyCount).toBe(0);
    expect(summary.journeysNeedingReviewCount).toBe(0);
  });

  it("derives application/environment, approved/needs-review counts, latest outcome, and policy from the map", () => {
    const summary = buildMapHomeSummary(sampleApplicationTestMap);
    expect(summary.hasMap).toBe(true);
    expect(summary.applicationName).toBe("Shop Staging");
    expect(summary.environment).toBe("staging");

    const journeys = sampleApplicationTestMap.areas.flatMap((area) => area.journeys);
    const expectedApproved = journeys.filter((journey) => journey.status === "approved").length;
    const expectedDraft = journeys.filter((journey) => journey.status === "draft").length;
    expect(summary.approvedJourneyCount).toBe(expectedApproved);
    expect(summary.journeysNeedingReviewCount).toBe(expectedDraft);
    expect(summary.approvedJourneyCount).toBeGreaterThan(0);

    // The most recently run journey in the fixture is anchored to RECENT_RUN_AT (2026-09-17).
    expect(summary.latestRunOutcome).toBeDefined();
    expect(summary.executionModeLabel).not.toBe(sampleApplicationTestMap.approvedScope.executionMode);
    expect(summary.executionModeLabel.length).toBeGreaterThan(0);
    if (sampleApplicationTestMap.approvedScope.executionMode === "safe_test") {
      expect(summary.executionModeLabel).toContain("Safe test");
    }
  });
});

describe("selectActiveMap", () => {
  it("returns undefined for an empty list and the sole map for a single-item list", () => {
    expect(selectActiveMap([])).toBeUndefined();
    expect(selectActiveMap([sampleApplicationTestMap])?.id).toBe(sampleApplicationTestMap.id);
  });

  it("picks the most recently updated map, regardless of input order", () => {
    const older = { ...sampleApplicationTestMap, id: "older-map", updatedAt: "2020-01-01T00:00:00.000Z" };
    const newer = { ...sampleApplicationTestMap, id: "newer-map", updatedAt: "2030-01-01T00:00:00.000Z" };
    expect(selectActiveMap([older, newer])?.id).toBe("newer-map");
    expect(selectActiveMap([newer, older])?.id).toBe("newer-map");
  });
});

describe("buildAreaSummaries", () => {
  it("computes approved-journey and recent-failure counts per area from already-fetched journeys", () => {
    const summaries = buildAreaSummaries(sampleApplicationTestMap);
    const checkout = summaries.find((area) => area.id === "checkout");
    expect(checkout).toBeDefined();
    expect(checkout?.recentFailureCount).toBe(
      checkout?.journeys.filter((journey) => journey.lastRunOutcome === "failed").length,
    );
    expect(checkout?.approvedJourneyCount).toBe(
      checkout?.journeys.filter((journey) => journey.status === "approved").length,
    );
    expect(checkout?.recentFailureCount).toBeGreaterThan(0);
  });
});

describe("estimateJourneyDurationSeconds / formatDurationLabel", () => {
  it("estimates duration as checkpoints.length * 45s and formats it as a rounded minute label", () => {
    const journey = sampleApplicationTestMap.areas
      .flatMap((area) => area.journeys)
      .find((candidate) => candidate.id === "registered_customer_checkout");
    expect(journey).toBeDefined();
    const seconds = estimateJourneyDurationSeconds(journey!);
    expect(seconds).toBe(journey!.checkpoints.length * 45);
    expect(formatDurationLabel(seconds)).toMatch(/^~\d+m$/);
  });
});

describe("journeyModeLabel / journeyRiskLevel / preRunActionLabel", () => {
  it("labels every execution mode and derives risk from the highest-risk checkpoint", () => {
    expect(journeyModeLabel("quick_test")).toBe("Quick test");
    expect(journeyModeLabel("guided_test")).toBe("Guided test");
    expect(journeyModeLabel("controlled_test")).toBe("Controlled test");

    const guestCheckout = sampleApplicationTestMap.areas
      .flatMap((area) => area.journeys)
      .find((candidate) => candidate.id === "guest_checkout");
    expect(journeyRiskLevel(guestCheckout!)).toBe("high");
  });

  it("gives each journey mode its own pre-run action label", () => {
    expect(preRunActionLabel("quick_test")).toBe("Run now");
    expect(preRunActionLabel("guided_test")).toBe("Review plan");
    expect(preRunActionLabel("controlled_test")).toBe("Submit for approval");
  });
});

describe("resolveFirstRequiredPersonaName", () => {
  it("resolves the first required persona's name, and undefined when none is required", () => {
    const registeredCheckout = sampleApplicationTestMap.areas
      .flatMap((area) => area.journeys)
      .find((candidate) => candidate.id === "registered_customer_checkout");
    expect(resolveFirstRequiredPersonaName(sampleApplicationTestMap, registeredCheckout!)).toBe(
      "Standard Customer",
    );

    const catalogueBrowse = sampleApplicationTestMap.areas
      .flatMap((area) => area.journeys)
      .find((candidate) => candidate.id === "browse_product_catalogue");
    expect(resolveFirstRequiredPersonaName(sampleApplicationTestMap, catalogueBrowse!)).toBeUndefined();
  });
});
