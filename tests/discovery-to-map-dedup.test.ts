import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { DiscoveredPage, DiscoverySnapshot } from "../src/domain/index.js";
import { buildDraftMapFromDiscovery } from "../src/services/testmap/discovery-to-map.js";

function page(overrides: Partial<DiscoveredPage>): DiscoveredPage {
  return {
    url: "https://example.com/",
    title: "Example",
    forms: [],
    buttons: [],
    links: [],
    consoleErrors: [],
    ...overrides,
  };
}

function snapshot(pages: DiscoveredPage[]): DiscoverySnapshot {
  return {
    runId: randomUUID(),
    targetUrl: "https://example.com/",
    visitedUrls: pages.map((p) => p.url),
    pages,
    apiEndpoints: [],
    capturedAt: new Date().toISOString(),
  };
}

describe("buildDraftMapFromDiscovery", () => {
  it("does not draft two journeys sharing the same id even if two distinct pages produce the same title", () => {
    // A crawl regression (e.g. duplicate-visiting the same effective page via
    // a trailing-slash variant) can hand two DiscoveredPage entries with the
    // same title into the same area. Journey ids are derived from title, so
    // without a guard this would silently produce two journeys sharing one
    // id — making that id ambiguous for `journey approve`/`journey run`.
    const pages = [
      page({ url: "https://example.com/", title: "Home" }),
      page({ url: "https://example.com", title: "Home" }),
    ];

    const map = buildDraftMapFromDiscovery(snapshot(pages), {
      applicationName: "example",
      environment: "staging",
      allowedDomains: ["example.com"],
    });

    const journeyIds = map.areas.flatMap((area) => area.journeys.map((journey) => journey.id));
    expect(journeyIds).toHaveLength(new Set(journeyIds).size);
    expect(journeyIds).toHaveLength(1);
  });

  it("still drafts distinct journeys for pages with distinct titles", () => {
    const pages = [
      page({ url: "https://example.com/", title: "Home" }),
      page({ url: "https://example.com/pricing", title: "Pricing" }),
    ];

    const map = buildDraftMapFromDiscovery(snapshot(pages), {
      applicationName: "example",
      environment: "staging",
      allowedDomains: ["example.com"],
    });

    const journeyIds = map.areas.flatMap((area) => area.journeys.map((journey) => journey.id));
    expect(journeyIds).toHaveLength(2);
  });
});
