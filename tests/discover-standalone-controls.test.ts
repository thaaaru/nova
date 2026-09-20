import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DiscoveredPage, DiscoverySnapshot } from "../src/domain/index.js";
import { buildDraftMapFromDiscovery } from "../src/services/testmap/discovery-to-map.js";
import { discoverApplication, newRunId } from "../src/services/browser/discover.js";

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

describe("buildDraftMapFromDiscovery — standalone controls", () => {
  it("drafts a journey for a button that is not inside any form", () => {
    const pages = [
      page({
        url: "https://example.com/",
        title: "Home",
        buttons: [{ kind: "button", text: "Subscribe to newsletter" }],
      }),
    ];

    const map = buildDraftMapFromDiscovery(snapshot(pages), {
      applicationName: "example",
      environment: "staging",
      allowedDomains: ["example.com"],
    });

    const journeyNames = map.areas.flatMap((area) => area.journeys.map((journey) => journey.name));
    expect(journeyNames).toContain('"Subscribe to newsletter" on Home');
  });

  it("never drafts a journey for a pure navigation link — the linked page's own smoke journey already covers it", () => {
    const pages = [
      page({
        url: "https://example.com/",
        title: "Home",
        links: [{ kind: "link", text: "Sign in", href: "/login" }],
      }),
    ];

    const map = buildDraftMapFromDiscovery(snapshot(pages), {
      applicationName: "example",
      environment: "staging",
      allowedDomains: ["example.com"],
    });

    const journeyNames = map.areas.flatMap((area) => area.journeys.map((journey) => journey.name));
    expect(journeyNames.some((name) => name.includes("Sign in"))).toBe(false);
    // Only the page-load smoke journey for Home remains.
    expect(journeyNames).toEqual(["Home loads"]);
  });

  it("deduplicates standalone buttons that share identical text on the same page", () => {
    const pages = [
      page({
        url: "https://example.com/",
        title: "Home",
        buttons: [
          { kind: "button", text: "Add to cart" },
          { kind: "button", text: "Add to cart" },
        ],
      }),
    ];

    const map = buildDraftMapFromDiscovery(snapshot(pages), {
      applicationName: "example",
      environment: "staging",
      allowedDomains: ["example.com"],
    });

    const controlJourneys = map.areas
      .flatMap((area) => area.journeys)
      .filter((journey) => journey.name.includes("Add to cart"));
    expect(controlJourneys).toHaveLength(1);
  });

  it("skips a button with empty or whitespace-only text — nothing meaningful to name the journey after", () => {
    const pages = [
      page({
        url: "https://example.com/",
        title: "Home",
        buttons: [{ kind: "button", text: "   " }],
      }),
    ];

    const map = buildDraftMapFromDiscovery(snapshot(pages), {
      applicationName: "example",
      environment: "staging",
      allowedDomains: ["example.com"],
    });

    const journeyNames = map.areas.flatMap((area) => area.journeys.map((journey) => journey.name));
    expect(journeyNames).toEqual(["Home loads"]);
  });

  it("caps standalone-control journeys per page so a button-heavy page does not flood the draft map", () => {
    const pages = [
      page({
        url: "https://example.com/",
        title: "Home",
        buttons: Array.from({ length: 12 }, (_, index) => ({
          kind: "button" as const,
          text: `Control ${index}`,
        })),
      }),
    ];

    const map = buildDraftMapFromDiscovery(snapshot(pages), {
      applicationName: "example",
      environment: "staging",
      allowedDomains: ["example.com"],
    });

    const controlJourneys = map.areas
      .flatMap((area) => area.journeys)
      .filter((journey) => journey.name.includes("Control "));
    expect(controlJourneys.length).toBeLessThanOrEqual(5);
  });

  it("marks a control journey guided_test, medium risk, and requiring approval — the same posture as a form journey", () => {
    const pages = [
      page({
        url: "https://example.com/",
        title: "Home",
        buttons: [{ kind: "button", text: "Delete account" }],
      }),
    ];

    const map = buildDraftMapFromDiscovery(snapshot(pages), {
      applicationName: "example",
      environment: "staging",
      allowedDomains: ["example.com"],
    });

    const journey = map.areas
      .flatMap((area) => area.journeys)
      .find((candidate) => candidate.name.includes("Delete account"));
    expect(journey?.mode).toBe("guided_test");
    expect(journey?.status).toBe("draft");
    expect(journey?.checkpoints[0]?.riskLevel).toBe("medium");
    expect(journey?.checkpoints[0]?.requiresApproval).toBe(true);
  });
});

describe("buildDraftMapFromDiscovery — real end-to-end discovery of a standalone control", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const demoAppDir = join(process.cwd(), "fixtures", "demo-app");
    server = createServer((request, response) => {
      const path = request.url === "/" || !request.url ? "/index.html" : request.url;
      try {
        const body = readFileSync(join(demoAppDir, path));
        response.writeHead(200, { "content-type": "text/html" });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end("not found");
      }
    });
    const { promise: listening, resolve: listeningReady } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listeningReady);
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind the demo app test server.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    const { promise: closed, resolve: closedReady } = Promise.withResolvers<void>();
    server.close(() => closedReady());
    await closed;
  });

  it("crawls the real demo app's standalone 'Subscribe to newsletter' button into a draft journey", async () => {
    const runId = newRunId();
    const discovered = await discoverApplication({
      runId,
      manifest: {
        targetId: "demo-app",
        baseUrl,
        allowedDomains: [new URL(baseUrl).hostname],
        environment: "local",
        description: "Standalone control discovery test",
        runExecutionMode: "observe",
        createdAt: new Date().toISOString(),
      },
      headless: true,
    });

    const homePage = discovered.pages.find(
      (candidate) => candidate.url.endsWith("/") || candidate.url === baseUrl,
    );
    expect(homePage?.buttons.map((button) => button.text)).toContain("Subscribe to newsletter");

    const map = buildDraftMapFromDiscovery(discovered, {
      applicationName: "Demo Shop",
      environment: "local",
      allowedDomains: [new URL(baseUrl).hostname],
    });

    const journeyNames = map.areas.flatMap((area) => area.journeys.map((journey) => journey.name));
    expect(journeyNames.some((name) => name.includes("Subscribe to newsletter"))).toBe(true);
  }, 20_000);
});
