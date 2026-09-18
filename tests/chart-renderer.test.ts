import { describe, expect, it } from "vitest";

import {
  renderDistributionChart,
  renderDurationChart,
  renderRecoveryFunnelChart,
  renderRiskOutcomeChart,
  renderTrendChart,
} from "../src/services/reporting/chart-renderer.js";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("renderDistributionChart", () => {
  it("renders one arc and one legend label per classification for a normal distribution", () => {
    const svg = renderDistributionChart({ passed: 3, failed: 2, flaky: 1, blocked: 1, inconclusive: 1 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(countOccurrences(svg, "<circle")).toBe(5);
    expect(svg).toContain("<title");
    expect(svg).toContain("Passed: 3");
    expect(svg).toContain("Failed: 2");
    expect(svg).toContain("8"); // total count rendered in the center label
  });

  it("still renders five zero-length arcs and a legend for an all-zero distribution", () => {
    const svg = renderDistributionChart({ passed: 0, failed: 0, flaky: 0, blocked: 0, inconclusive: 0 });
    expect(countOccurrences(svg, "<circle")).toBe(5);
    expect(svg).toContain("<title");
    expect(svg).toContain("Passed: 0 (0%)");
    expect(svg).toContain("No verification results are available yet.");
  });
});

describe("renderDurationChart", () => {
  it("renders one bar and one label per case for a normal dataset", () => {
    const svg = renderDurationChart([
      { caseId: "a", title: "Case A", durationMs: 1000 },
      { caseId: "b", title: "Case B", durationMs: 4000 },
    ]);
    expect(svg).toContain("<title");
    expect(countOccurrences(svg, 'data-case-id="a"')).toBeGreaterThan(0);
    expect(svg).toContain("Case A");
    expect(svg).toContain("Case B");
    expect(countOccurrences(svg, '<rect x="220"')).toBe(2);
  });

  it("renders a single bar for a single test case", () => {
    const svg = renderDurationChart([{ caseId: "solo", title: "Solo case", durationMs: 500 }]);
    expect(countOccurrences(svg, '<rect x="220"')).toBe(1);
    expect(svg).toContain("Solo case");
    expect(svg).toContain("500ms");
  });

  it("renders a 'no data' message for an empty dataset without throwing", () => {
    const svg = renderDurationChart([]);
    expect(svg).toContain("No case durations recorded.");
    expect(countOccurrences(svg, '<rect x="220"')).toBe(0);
  });
});

describe("renderRiskOutcomeChart", () => {
  it("renders one stacked segment per risk/classification cell for a normal dataset", () => {
    const svg = renderRiskOutcomeChart([
      { riskLevel: "high", classification: "failed", count: 2 },
      { riskLevel: "low", classification: "passed", count: 1 },
    ]);
    expect(svg).toContain("<title");
    expect(svg).toContain("High risk");
    expect(svg).toContain("Low risk");
    expect(countOccurrences(svg, 'data-classification="failed"')).toBe(1);
    expect(countOccurrences(svg, 'data-classification="passed"')).toBe(1);
  });

  it("renders the three risk rows with no segments for an empty dataset", () => {
    const svg = renderRiskOutcomeChart([]);
    expect(svg).toContain("High risk");
    expect(svg).toContain("Medium risk");
    expect(svg).toContain("Low risk");
    expect(countOccurrences(svg, "data-classification=")).toBe(0);
    expect(svg).toContain("No risk versus outcome data is available.");
  });
});

describe("renderRecoveryFunnelChart", () => {
  it("renders all five funnel stages with proportional bars for a normal funnel", () => {
    const svg = renderRecoveryFunnelChart({
      failuresDetected: 4,
      recoveryAttempted: 3,
      recovered: 1,
      confirmedDefect: 2,
      blocked: 1,
    });
    expect(svg).toContain("<title");
    expect(countOccurrences(svg, "data-stage=")).toBe(5);
    expect(svg).toContain("Failures detected");
    expect(svg).toContain("Confirmed defect");
  });

  it("still renders five stage rows for an empty funnel", () => {
    const svg = renderRecoveryFunnelChart({
      failuresDetected: 0,
      recoveryAttempted: 0,
      recovered: 0,
      confirmedDefect: 0,
      blocked: 0,
    });
    expect(countOccurrences(svg, "data-stage=")).toBe(5);
    expect(svg).toContain("Recovery funnel: Failures detected 0");
  });
});

describe("renderTrendChart", () => {
  it("renders two bars per run for a populated trend", () => {
    const svg = renderTrendChart([
      { runId: "run-1", completedAt: "2024-01-01T00:00:00.000Z", passed: 3, failed: 1 },
      { runId: "run-2", completedAt: "2024-01-02T00:00:00.000Z", passed: 4, failed: 0 },
    ]);
    expect(svg).toContain("<title");
    expect(countOccurrences(svg, 'data-run-id="run-1"')).toBe(2);
    expect(countOccurrences(svg, 'data-run-id="run-2"')).toBe(2);
  });

  it("renders a 'no data' message for an empty trend", () => {
    const svg = renderTrendChart([]);
    expect(svg).toContain("No historical comparison available.");
  });
});
