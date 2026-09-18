import type {
  CaseDuration,
  RecoveryFunnel,
  ResultDistribution,
  RiskOutcomeCell,
  RiskLevel,
  TrendPoint,
  VerificationClassification,
} from "../../domain/index.js";

/**
 * Nova's palette, shared between the inline SVG charts here and the badge
 * colors in html-report-generator.ts. Green is reserved for a genuinely
 * passed result and red for a confirmed failure — every other outcome uses
 * cyan/violet/amber so color is never the only signal (each chart also
 * carries text labels).
 */
export const CHART_COLORS = {
  background: "#0a1628",
  panel: "#0f2138",
  grid: "#1e3a5f",
  text: "#e2e8f0",
  muted: "#94a3b8",
  cyan: "#38bdf8",
  violet: "#a78bfa",
  green: "#34d399",
  amber: "#fbbf24",
  red: "#f87171",
} as const;

export const CLASSIFICATION_COLORS: Record<VerificationClassification, string> = {
  passed: CHART_COLORS.green,
  failed: CHART_COLORS.red,
  flaky: CHART_COLORS.violet,
  blocked: CHART_COLORS.amber,
  inconclusive: CHART_COLORS.cyan,
};

const CLASSIFICATION_LABELS: Record<VerificationClassification, string> = {
  passed: "Passed",
  failed: "Failed",
  flaky: "Flaky",
  blocked: "Blocked",
  inconclusive: "Inconclusive",
};

const RISK_LABELS: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

export function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function svgDocument(width: number, height: number, title: string, desc: string, body: string): string {
  return [
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="svg-title svg-desc">`,
    `<title id="svg-title">${escapeSvgText(title)}</title>`,
    `<desc id="svg-desc">${escapeSvgText(desc)}</desc>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${CHART_COLORS.panel}" rx="12" />`,
    body,
    `</svg>`,
  ].join("\n");
}

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remainderSeconds}s`;
}

/** Donut chart: one arc per verification classification, always five arcs (zero-length when the count is zero) so the legend and element count stay stable regardless of data shape. */
export function renderDistributionChart(distribution: ResultDistribution): string {
  const width = 420;
  const height = 260;
  const cx = 130;
  const cy = 130;
  const radius = 90;
  const strokeWidth = 34;
  const circumference = 2 * Math.PI * radius;
  const order: VerificationClassification[] = ["passed", "failed", "flaky", "blocked", "inconclusive"];
  const total = order.reduce((sum, key) => sum + distribution[key], 0);

  let cumulative = 0;
  const arcs = order
    .map((key) => {
      const count = distribution[key];
      const fraction = total > 0 ? count / total : 0;
      const segmentLength = fraction * circumference;
      const dashArray = `${segmentLength} ${Math.max(circumference - segmentLength, 0)}`;
      const dashOffset = -cumulative;
      cumulative += segmentLength;
      return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${CLASSIFICATION_COLORS[key]}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" stroke-dashoffset="${dashOffset}" transform="rotate(-90 ${cx} ${cy})" data-classification="${key}" data-count="${count}" />`;
    })
    .join("\n");

  const centerLabel = `<text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${CHART_COLORS.text}" font-size="28" font-weight="700">${total}</text><text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="${CHART_COLORS.muted}" font-size="13">total cases</text>`;

  const legend = order
    .map((key, index) => {
      const count = distribution[key];
      const percent = total > 0 ? Math.round((count / total) * 100) : 0;
      const y = 30 + index * 40;
      return [
        `<rect x="280" y="${y - 14}" width="16" height="16" rx="3" fill="${CLASSIFICATION_COLORS[key]}" />`,
        `<text x="304" y="${y - 1}" fill="${CHART_COLORS.text}" font-size="14">${escapeSvgText(CLASSIFICATION_LABELS[key])}: ${count} (${percent}%)</text>`,
      ].join("\n");
    })
    .join("\n");

  const body = `${arcs}\n${centerLabel}\n${legend}`;
  const desc =
    total > 0
      ? `Result distribution across ${total} test case${total === 1 ? "" : "s"}: ${order.map((key) => `${CLASSIFICATION_LABELS[key]} ${distribution[key]}`).join(", ")}.`
      : "No verification results are available yet.";
  return svgDocument(width, height, "Result distribution", desc, body);
}

/** Horizontal bar chart, one bar per test case duration. */
export function renderDurationChart(durations: CaseDuration[]): string {
  const width = 640;
  const rowHeight = 34;
  const paddingTop = 20;
  const paddingBottom = 20;
  const labelWidth = 220;
  const barAreaWidth = width - labelWidth - 80;
  const height = paddingTop + paddingBottom + Math.max(durations.length, 1) * rowHeight;

  if (durations.length === 0) {
    const body = `<text x="20" y="${height / 2}" fill="${CHART_COLORS.muted}" font-size="14">No case durations recorded.</text>`;
    return svgDocument(width, height, "Duration by test case", "No case durations recorded.", body);
  }

  const maxDuration = Math.max(...durations.map((entry) => entry.durationMs), 1);
  const bars = durations
    .map((entry, index) => {
      const y = paddingTop + index * rowHeight;
      const barWidth = Math.max((entry.durationMs / maxDuration) * barAreaWidth, 2);
      const label = entry.title.length > 28 ? `${entry.title.slice(0, 27)}…` : entry.title;
      return [
        `<text x="0" y="${y + rowHeight / 2 + 5}" fill="${CHART_COLORS.text}" font-size="13" data-case-id="${escapeSvgText(entry.caseId)}">${escapeSvgText(label)}</text>`,
        `<rect x="${labelWidth}" y="${y + 6}" width="${barWidth}" height="${rowHeight - 14}" rx="4" fill="${CHART_COLORS.cyan}" data-case-id="${escapeSvgText(entry.caseId)}" data-duration-ms="${entry.durationMs}" />`,
        `<text x="${labelWidth + barWidth + 8}" y="${y + rowHeight / 2 + 5}" fill="${CHART_COLORS.muted}" font-size="12">${formatMs(entry.durationMs)}</text>`,
      ].join("\n");
    })
    .join("\n");

  const desc = `Duration for ${durations.length} test case${durations.length === 1 ? "" : "s"}, longest ${formatMs(maxDuration)}.`;
  return svgDocument(width, height, "Duration by test case", desc, bars);
}

/** Stacked horizontal bar chart: one row per risk level, segmented by verification classification. */
export function renderRiskOutcomeChart(cells: RiskOutcomeCell[]): string {
  const width = 640;
  const rowHeight = 48;
  const paddingTop = 20;
  const labelWidth = 110;
  const barAreaWidth = width - labelWidth - 40;
  const riskLevels: RiskLevel[] = ["high", "medium", "low"];
  const height = paddingTop + riskLevels.length * rowHeight + 40;

  const rowsByRisk: Record<RiskLevel, RiskOutcomeCell[]> = { low: [], medium: [], high: [] };
  for (const cell of cells) {
    rowsByRisk[cell.riskLevel].push(cell);
  }

  const rowTotals = riskLevels.map((level) => rowsByRisk[level].reduce((sum, cell) => sum + cell.count, 0));
  const maxTotal = Math.max(...rowTotals, 1);

  const rows = riskLevels
    .map((level, rowIndex) => {
      const y = paddingTop + rowIndex * rowHeight;
      const rowCells = rowsByRisk[level];
      const rowTotal = rowTotals[rowIndex] ?? 0;
      const rowWidth = rowTotal > 0 ? (rowTotal / maxTotal) * barAreaWidth : 0;
      let x = labelWidth;
      const segments = rowCells
        .map((cell) => {
          const segmentWidth = rowTotal > 0 ? (cell.count / rowTotal) * rowWidth : 0;
          const segment = `<rect x="${x}" y="${y + 8}" width="${Math.max(segmentWidth, cell.count > 0 ? 2 : 0)}" height="${rowHeight - 22}" fill="${CLASSIFICATION_COLORS[cell.classification]}" data-risk-level="${level}" data-classification="${cell.classification}" data-count="${cell.count}" />`;
          x += segmentWidth;
          return segment;
        })
        .join("\n");
      const label = `<text x="0" y="${y + rowHeight / 2 - 2}" fill="${CHART_COLORS.text}" font-size="13">${escapeSvgText(RISK_LABELS[level])}</text>`;
      const total = `<text x="0" y="${y + rowHeight / 2 + 14}" fill="${CHART_COLORS.muted}" font-size="11">${rowTotal} case${rowTotal === 1 ? "" : "s"}</text>`;
      return `${label}\n${total}\n${segments}`;
    })
    .join("\n");

  const legend = (["passed", "failed", "flaky", "blocked", "inconclusive"] as VerificationClassification[])
    .map((key, index) => {
      const legendX = labelWidth + index * 100;
      const legendY = height - 14;
      return `<rect x="${legendX}" y="${legendY - 12}" width="10" height="10" fill="${CLASSIFICATION_COLORS[key]}" /><text x="${legendX + 14}" y="${legendY - 2}" fill="${CHART_COLORS.muted}" font-size="11">${escapeSvgText(CLASSIFICATION_LABELS[key])}</text>`;
    })
    .join("\n");

  const desc =
    cells.length > 0
      ? `Risk level versus outcome across ${cells.reduce((sum, cell) => sum + cell.count, 0)} test cases.`
      : "No risk versus outcome data is available.";
  return svgDocument(width, height, "Risk level vs outcome", desc, `${rows}\n${legend}`);
}

const FUNNEL_STAGES: Array<{ key: keyof RecoveryFunnel; label: string; color: string }> = [
  { key: "failuresDetected", label: "Failures detected", color: CHART_COLORS.cyan },
  { key: "recoveryAttempted", label: "Recovery attempted", color: CHART_COLORS.violet },
  { key: "recovered", label: "Recovered", color: CHART_COLORS.green },
  { key: "confirmedDefect", label: "Confirmed defect", color: CHART_COLORS.red },
  { key: "blocked", label: "Blocked", color: CHART_COLORS.amber },
];

/** Funnel visualization for the recovery pipeline; always renders all five stages so shape is stable even when every count is zero. */
export function renderRecoveryFunnelChart(funnel: RecoveryFunnel): string {
  const width = 560;
  const rowHeight = 40;
  const paddingTop = 16;
  const labelWidth = 190;
  const barAreaWidth = width - labelWidth - 60;
  const height = paddingTop + FUNNEL_STAGES.length * rowHeight + 16;
  const maxValue = Math.max(funnel.failuresDetected, 1);

  const rows = FUNNEL_STAGES.map((stage, index) => {
    const value = funnel[stage.key];
    const y = paddingTop + index * rowHeight;
    const barWidth = value > 0 ? Math.max((value / maxValue) * barAreaWidth, 3) : 0;
    return [
      `<text x="0" y="${y + rowHeight / 2 + 5}" fill="${CHART_COLORS.text}" font-size="13">${escapeSvgText(stage.label)}</text>`,
      `<rect x="${labelWidth}" y="${y + 6}" width="${barWidth}" height="${rowHeight - 16}" rx="4" fill="${stage.color}" data-stage="${stage.key}" data-value="${value}" />`,
      `<text x="${labelWidth + barWidth + 8}" y="${y + rowHeight / 2 + 5}" fill="${CHART_COLORS.muted}" font-size="12">${value}</text>`,
    ].join("\n");
  }).join("\n");

  const desc = `Recovery funnel: ${FUNNEL_STAGES.map((stage) => `${stage.label} ${funnel[stage.key]}`).join(", ")}.`;
  return svgDocument(width, height, "Recovery funnel", desc, rows);
}

/** Simple grouped bar chart for pass/fail trend across recent runs; only rendered when historical data exists. */
export function renderTrendChart(trend: TrendPoint[]): string {
  const width = 640;
  const height = 220;
  const paddingLeft = 40;
  const paddingBottom = 40;
  const chartWidth = width - paddingLeft - 20;
  const chartHeight = height - paddingBottom - 20;

  if (trend.length === 0) {
    const body = `<text x="20" y="${height / 2}" fill="${CHART_COLORS.muted}" font-size="14">No historical comparison available.</text>`;
    return svgDocument(width, height, "Pass/fail trend", "No historical comparison available.", body);
  }

  const maxTotal = Math.max(...trend.map((point) => point.passed + point.failed), 1);
  const groupWidth = chartWidth / trend.length;
  const bars = trend
    .map((point, index) => {
      const groupX = paddingLeft + index * groupWidth;
      const passedHeight = (point.passed / maxTotal) * chartHeight;
      const failedHeight = (point.failed / maxTotal) * chartHeight;
      const passedY = 20 + chartHeight - passedHeight;
      const failedY = 20 + chartHeight - failedHeight;
      const barWidth = Math.max(groupWidth / 2 - 6, 4);
      const dateLabel = point.completedAt.slice(0, 10);
      return [
        `<rect x="${groupX + 4}" y="${passedY}" width="${barWidth}" height="${passedHeight}" fill="${CHART_COLORS.green}" data-run-id="${escapeSvgText(point.runId)}" data-passed="${point.passed}" />`,
        `<rect x="${groupX + barWidth + 8}" y="${failedY}" width="${barWidth}" height="${failedHeight}" fill="${CHART_COLORS.red}" data-run-id="${escapeSvgText(point.runId)}" data-failed="${point.failed}" />`,
        `<text x="${groupX + groupWidth / 2}" y="${height - 12}" text-anchor="middle" fill="${CHART_COLORS.muted}" font-size="10">${escapeSvgText(dateLabel)}</text>`,
      ].join("\n");
    })
    .join("\n");

  const axis = `<line x1="${paddingLeft}" y1="${20 + chartHeight}" x2="${width - 20}" y2="${20 + chartHeight}" stroke="${CHART_COLORS.grid}" stroke-width="1" />`;
  const desc = `Pass/fail trend across ${trend.length} prior run${trend.length === 1 ? "" : "s"}.`;
  return svgDocument(width, height, "Pass/fail trend", desc, `${axis}\n${bars}`);
}
