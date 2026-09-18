import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BrandConfig } from "../src/brand.js";
import { renderReportHtml } from "../src/reporting/report.js";
import type { WorkflowResult } from "../src/workflow/harness-workflow.js";

const brand: BrandConfig = { productName: "Acme Assure", cliDisplayName: "acme-assure" };

function fixtureScreenshot(): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-report-test-"));
  const path = join(dir, "screenshot.png");
  // Minimal valid 1x1 PNG.
  writeFileSync(
    path,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  return path;
}

describe("renderReportHtml", () => {
  it("includes the brand name, run status, and an embedded screenshot", () => {
    const runId = randomUUID();
    const result: WorkflowResult = {
      runId,
      status: "passed",
      execution: {
        runId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "passed",
        checks: [
          {
            url: "https://example.test/",
            expectedTitle: "Example",
            observedTitle: "Example",
            status: "passed",
            screenshotPath: fixtureScreenshot(),
          },
        ],
        interactions: [],
      },
    };

    const html = renderReportHtml(result, brand);

    expect(html).toContain("Acme Assure");
    expect(html).toContain(runId);
    expect(html).toContain('class="badge passed"');
    expect(html).toContain("data:image/png;base64,");
  });

  it("renders failed checks and missing screenshots without throwing", () => {
    const runId = randomUUID();
    const result: WorkflowResult = {
      runId,
      status: "failed",
      execution: {
        runId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "failed",
        checks: [
          {
            url: "https://example.test/broken",
            expectedTitle: "Example",
            status: "failed",
            error: "Timed out waiting for navigation",
          },
        ],
        interactions: [],
      },
    };

    const html = renderReportHtml(result, brand);

    expect(html).toContain('class="badge failed"');
    expect(html).toContain("Timed out waiting for navigation");
  });
});
