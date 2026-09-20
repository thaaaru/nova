import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { BrandConfig } from "../src/brand.js";
import { renderReviewPage } from "../src/review/review-html.js";
import type { WorkflowResult } from "../src/workflow/harness-workflow.js";

const brand: BrandConfig = { productName: "Acme Assure", cliDisplayName: "acme-assure" };

describe("renderReviewPage", () => {
  it("includes the brand name, an approve button, and the discovered page", () => {
    const runId = randomUUID();
    const result: WorkflowResult = {
      runId,
      status: "awaiting_approval",
      plan: {
        id: randomUUID(),
        runId,
        createdAt: new Date().toISOString(),
        summary: "Read-only discovery found 1 route(s).",
        discoveredRoutes: ["/"],
        steps: [
          {
            id: "open-start-page",
            title: "Open /",
            rationale: "Begin from the initial page.",
            risk: "read_only",
            requiresApproval: false,
            actions: [{ kind: "navigate", description: "Navigate to /." }],
            expectedResult: "Reachable.",
          },
        ],
        warnings: [],
      },
      snapshot: {
        id: randomUUID(),
        targetUrl: "https://example.test/",
        discoveredAt: new Date().toISOString(),
        warnings: [],
        pages: [
          {
            url: "https://example.test/",
            path: "/",
            title: "Example",
            headings: ["Welcome"],
            controls: [],
            links: [],
            consoleErrors: [],
            pageErrors: [],
            fingerprint: "fixture",
          },
        ],
      },
    };

    const html = renderReviewPage(result, brand);

    expect(html).toContain("Acme Assure");
    expect(html).toContain(runId);
    expect(html).toContain('class="approve"');
    expect(html).toContain('class="reject"');
    expect(html).toContain("Example");
  });
});
