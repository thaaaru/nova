import type {
  Finding,
  Governance,
  ReportData,
  ReportHeader,
  ReportRecoveryAttempt,
  RunStatus,
  TestCaseDetail,
  TimelineStage,
  VerificationClassification,
} from "../../domain/index.js";
import {
  CHART_COLORS,
  CLASSIFICATION_COLORS,
  renderDistributionChart,
  renderDurationChart,
  renderRecoveryFunnelChart,
  renderRiskOutcomeChart,
  renderTrendChart,
} from "./chart-renderer.js";

/**
 * Renders one complete, self-contained HTML document from an already
 * redacted ReportData view model. This module never reads TestRunState —
 * see report-data-adapter.ts for the single place raw run state is
 * translated into what gets shown here.
 */
export function buildHtmlReport(report: ReportData): string {
  return [
    "<!doctype html>",
    `<html lang="en">`,
    renderHead(report.header),
    "<body>",
    renderHeader(report.header, report.executiveSummary),
    "<main>",
    renderExecutiveSummary(report.executiveSummary),
    renderTimeline(report.timeline),
    renderCharts(report.charts),
    renderTestCases(report.testCases),
    renderFindings(report.findings),
    renderGovernance(report.governance),
    "</main>",
    renderFooter(report.footer),
    renderScript(),
    "</body>",
    "</html>",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) {
    return "—";
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return escapeHtml(iso);
  }
  return `${parsed.toISOString().replace("T", " ").replace("Z", " UTC")}`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return "—";
  }
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

const CLASSIFICATION_LABELS: Record<VerificationClassification, string> = {
  passed: "Passed",
  failed: "Failed",
  flaky: "Flaky",
  blocked: "Blocked",
  inconclusive: "Inconclusive",
};

function classificationBadge(classification: VerificationClassification, extra = ""): string {
  const color = CLASSIFICATION_COLORS[classification];
  const label = CLASSIFICATION_LABELS[classification];
  return `<span class="badge badge-${classification} ${extra}" style="--badge-color: ${color}">${escapeHtml(label)}</span>`;
}

const DEFECT_CLASSIFICATION_LABELS: Record<Finding["classification"], string> = {
  product_defect: "Product defect",
  flaky_test: "Flaky test",
  test_defect: "Test defect",
  infrastructure_failure: "Infrastructure failure",
};

function defectClassificationTag(classification: Finding["classification"]): string {
  return `<span class="tag tag-${classification.replaceAll("_", "-")}">${escapeHtml(DEFECT_CLASSIFICATION_LABELS[classification])}</span>`;
}

const SEVERITY_LABELS: Record<Finding["severity"], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

function severityTag(severity: Finding["severity"]): string {
  return `<span class="severity severity-${severity}">${escapeHtml(SEVERITY_LABELS[severity])}</span>`;
}

type OutcomeBadge = { label: string; className: string; color: string };

function outcomeBadge(header: ReportHeader, summary: ReportData["executiveSummary"]): OutcomeBadge {
  const statusLabel = header.terminalOutcome.replaceAll("_", " ");
  if (summary.failed > 0) {
    return { label: `Failed — ${statusLabel}`, className: "outcome-fail", color: CHART_COLORS.red };
  }
  const blockedStatuses: RunStatus[] = ["blocked", "awaiting_approval", "rejected"];
  if (blockedStatuses.includes(header.terminalOutcome) || summary.blocked > 0) {
    return { label: `Blocked — ${statusLabel}`, className: "outcome-blocked", color: CHART_COLORS.amber };
  }
  const allPassed =
    header.terminalOutcome === "completed" &&
    summary.totalTests > 0 &&
    summary.passed === summary.totalTests &&
    summary.blocked === 0 &&
    summary.inconclusive === 0;
  if (allPassed) {
    return { label: `All passed — ${statusLabel}`, className: "outcome-pass", color: CHART_COLORS.green };
  }
  return {
    label: statusLabel.replace(/^./, (c) => c.toUpperCase()),
    className: "outcome-neutral",
    color: CHART_COLORS.cyan,
  };
}

function renderHead(header: ReportHeader): string {
  return `<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nova report — ${escapeHtml(header.runId)}</title>
<style>${styleSheet()}</style>
</head>`;
}

function styleSheet(): string {
  return `
:root {
  color-scheme: dark;
  --bg: ${CHART_COLORS.background};
  --panel: ${CHART_COLORS.panel};
  --grid: ${CHART_COLORS.grid};
  --text: ${CHART_COLORS.text};
  --muted: ${CHART_COLORS.muted};
  --cyan: ${CHART_COLORS.cyan};
  --violet: ${CHART_COLORS.violet};
  --green: ${CHART_COLORS.green};
  --amber: ${CHART_COLORS.amber};
  --red: ${CHART_COLORS.red};
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.5;
}
main { max-width: 1100px; margin: 0 auto; padding: 0 24px 64px; }
section { margin-top: 40px; }
h1, h2, h3 { font-weight: 700; letter-spacing: -0.01em; }
h2 { border-bottom: 1px solid var(--grid); padding-bottom: 8px; }
a { color: var(--cyan); }
.wordmark { font-size: 22px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--cyan); }
header.run-header {
  padding: 32px 24px;
  background: linear-gradient(180deg, var(--panel), var(--bg));
  border-bottom: 1px solid var(--grid);
}
.run-header-top { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px; max-width: 1100px; margin: 0 auto; }
.outcome-badge { display: inline-block; padding: 6px 14px; border-radius: 999px; font-weight: 700; font-size: 14px; color: var(--bg); background: var(--badge-color, var(--cyan)); }
.outcome-pass { background: var(--green); }
.outcome-fail { background: var(--red); }
.outcome-blocked { background: var(--amber); }
.outcome-neutral { background: var(--cyan); }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px 24px; max-width: 1100px; margin: 20px auto 0; }
.meta-item dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
.meta-item dd { margin: 2px 0 0; font-size: 15px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; }
.stat-card { background: var(--panel); border: 1px solid var(--grid); border-radius: 10px; padding: 16px; }
.stat-card .value { font-size: 28px; font-weight: 800; }
.stat-card .label { color: var(--muted); font-size: 13px; }
.outcome-statement { font-size: 18px; margin-top: 20px; padding: 16px; background: var(--panel); border-left: 4px solid var(--cyan); border-radius: 6px; }
.timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.timeline-stage { display: grid; grid-template-columns: 140px auto 1fr; gap: 12px; align-items: center; background: var(--panel); border: 1px solid var(--grid); border-radius: 8px; padding: 12px 16px; }
.stage-status { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; width: fit-content; color: var(--bg); }
.stage-completed { background: var(--green); }
.stage-skipped { background: var(--muted); color: var(--bg); }
.stage-interrupted { background: var(--red); }
.stage-blocked { background: var(--amber); }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 24px; }
.chart-card { background: var(--panel); border: 1px solid var(--grid); border-radius: 10px; padding: 16px; }
.chart-card svg { width: 100%; height: auto; }
.no-data { color: var(--muted); font-style: italic; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; color: var(--bg); background: var(--badge-color, var(--cyan)); }
.badge-passed { background: var(--green); }
.badge-failed { background: var(--red); }
.badge-flaky { background: var(--violet); }
.badge-blocked { background: var(--amber); }
.badge-inconclusive { background: var(--cyan); }
.confidence { font-size: 12px; color: var(--muted); }
.case-card, .finding-card { background: var(--panel); border: 1px solid var(--grid); border-radius: 10px; padding: 20px; margin-bottom: 16px; }
.case-card-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); font-size: 13px; }
th { color: var(--muted); font-weight: 600; }
.pass-cell { color: var(--green); }
.fail-cell { color: var(--red); }
.recovery-card { border: 1px dashed var(--violet); border-radius: 8px; padding: 10px 14px; margin: 8px 0; font-size: 13px; }
.recovery-outcome { font-weight: 700; }
.recovery-outcome-recovered { color: var(--green); }
.recovery-outcome-exhausted { color: var(--red); }
.recovery-outcome-blocked_by_policy { color: var(--amber); }
.evidence-list { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-wrap: wrap; gap: 8px; }
.evidence-list li { background: var(--bg); border: 1px solid var(--grid); border-radius: 6px; padding: 4px 10px; font-size: 12px; }
details { margin-top: 10px; }
details > summary { cursor: pointer; color: var(--cyan); font-size: 13px; }
pre { background: var(--bg); border: 1px solid var(--grid); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 12px; }
.tag { display: inline-block; padding: 2px 10px; border-radius: 6px; font-size: 12px; font-weight: 700; }
.tag-product-defect { background: var(--red); color: var(--bg); }
.tag-flaky-test { background: var(--violet); color: var(--bg); }
.tag-test-defect { background: var(--amber); color: var(--bg); }
.tag-infrastructure-failure { background: var(--muted); color: var(--bg); }
.severity { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.severity-critical, .severity-high { color: var(--red); }
.severity-medium { color: var(--amber); }
.severity-low { color: var(--muted); }
.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
.toolbar button { background: var(--panel); color: var(--text); border: 1px solid var(--grid); border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.toolbar button:hover { border-color: var(--cyan); }
footer.report-footer { border-top: 1px solid var(--grid); margin-top: 48px; padding: 24px; text-align: center; color: var(--muted); font-size: 13px; }
@media (max-width: 640px) {
  .timeline-stage { grid-template-columns: 1fr; }
}
`;
}

function renderHeader(header: ReportHeader, summary: ReportData["executiveSummary"]): string {
  const badge = outcomeBadge(header, summary);
  return `<header class="run-header" id="section-header">
<div class="run-header-top">
<div>
<div class="wordmark">Nova</div>
<h1>Test run report</h1>
</div>
<span class="outcome-badge ${badge.className}" style="--badge-color: ${badge.color}">${escapeHtml(badge.label)}</span>
</div>
<dl class="meta-grid">
<div class="meta-item"><dt>Run ID</dt><dd>${escapeHtml(header.runId)}</dd></div>
<div class="meta-item"><dt>Project</dt><dd>${escapeHtml(header.projectId)}</dd></div>
<div class="meta-item"><dt>Environment</dt><dd>${escapeHtml(header.environment)}</dd></div>
<div class="meta-item"><dt>Target</dt><dd>${escapeHtml(header.targetBaseUrl)}</dd></div>
<div class="meta-item"><dt>Execution mode</dt><dd>${escapeHtml(header.executionMode)}</dd></div>
<div class="meta-item"><dt>Started</dt><dd>${formatDateTime(header.startedAt)}</dd></div>
<div class="meta-item"><dt>Completed</dt><dd>${formatDateTime(header.completedAt)}</dd></div>
<div class="meta-item"><dt>Total duration</dt><dd>${formatDuration(header.totalDurationMs)}</dd></div>
<div class="meta-item"><dt>Nova version</dt><dd>${escapeHtml(header.novaVersion)}</dd></div>
<div class="meta-item"><dt>Report schema</dt><dd>v${header.reportSchemaVersion}</dd></div>
</dl>
</header>`;
}

function renderExecutiveSummary(summary: ReportData["executiveSummary"]): string {
  const stats: Array<{ label: string; value: number }> = [
    { label: "Total tests", value: summary.totalTests },
    { label: "Passed", value: summary.passed },
    { label: "Failed", value: summary.failed },
    { label: "Flaky", value: summary.flaky },
    { label: "Blocked", value: summary.blocked },
    { label: "Inconclusive", value: summary.inconclusive },
    { label: "Recovery attempts", value: summary.recoveryAttempts },
    { label: "Approval interventions", value: summary.approvalInterventions },
    { label: "Defect candidates", value: summary.defectCandidates },
  ];
  const cards = stats
    .map(
      (stat) =>
        `<div class="stat-card"><div class="value">${stat.value}</div><div class="label">${escapeHtml(stat.label)}</div></div>`,
    )
    .join("\n");
  return `<section id="section-executive-summary" aria-labelledby="executive-summary-heading">
<h2 id="executive-summary-heading">Executive Summary</h2>
<div class="stat-grid">${cards}</div>
<p class="outcome-statement">${escapeHtml(summary.outcomeStatement)}</p>
</section>`;
}

const STAGE_TITLES: Record<TimelineStage["stage"], string> = {
  discover: "Discover",
  plan: "Plan",
  approval: "Approval",
  execute: "Execute",
  verify: "Verify",
  report: "Report",
};

function renderTimeline(timeline: TimelineStage[]): string {
  const items = timeline
    .map((stage) => {
      const note = stage.note ? `<div class="stage-note">${escapeHtml(stage.note)}</div>` : "";
      return `<li class="timeline-stage">
<strong>${escapeHtml(STAGE_TITLES[stage.stage])}</strong>
<span class="stage-status stage-${stage.status}">${escapeHtml(stage.status)}</span>
<div>
<div>${formatDuration(stage.elapsedMs)} elapsed${stage.completedAt ? ` · completed ${formatDateTime(stage.completedAt)}` : ""}</div>
${note}
</div>
</li>`;
    })
    .join("\n");
  return `<section id="section-timeline" aria-labelledby="timeline-heading">
<h2 id="timeline-heading">Workflow Timeline</h2>
<ol class="timeline">${items}</ol>
</section>`;
}

function renderCharts(charts: ReportData["charts"]): string {
  const trendSection = charts.trend
    ? renderTrendChart(charts.trend)
    : `<p class="no-data">No historical comparison available.</p>`;
  return `<section id="section-charts" aria-labelledby="charts-heading">
<h2 id="charts-heading">Charts</h2>
<div class="chart-grid">
<div class="chart-card">${renderDistributionChart(charts.distribution)}</div>
<div class="chart-card">${renderDurationChart(charts.durationsByCase)}</div>
<div class="chart-card">${renderRiskOutcomeChart(charts.riskOutcomeMatrix)}</div>
<div class="chart-card">${renderRecoveryFunnelChart(charts.recoveryFunnel)}</div>
<div class="chart-card" id="trend-chart">${trendSection}</div>
</div>
</section>`;
}

function renderRecoveryAttempt(attempt: ReportRecoveryAttempt): string {
  return `<div class="recovery-card">
<div><strong>${escapeHtml(attempt.checkpoint)}</strong> — attempt ${attempt.attempt} of ${attempt.maxAttempts}</div>
<div>Failure: ${escapeHtml(attempt.failureSummary)}</div>
<div>Action: ${escapeHtml(attempt.action)}</div>
<div class="recovery-outcome recovery-outcome-${attempt.outcome}">Outcome: ${escapeHtml(attempt.outcome.replaceAll("_", " "))}</div>
</div>`;
}

function renderAssertions(assertions: TestCaseDetail["assertions"]): string {
  if (assertions.length === 0) {
    return `<p class="no-data">No assertions recorded.</p>`;
  }
  const rows = assertions
    .map(
      (assertion) =>
        `<tr><td>${escapeHtml(assertion.kind)}</td><td>${escapeHtml(assertion.expected)}</td><td>${escapeHtml(assertion.observed ?? "—")}</td><td class="${assertion.passed ? "pass-cell" : "fail-cell"}">${assertion.passed ? "Pass" : "Fail"}</td></tr>`,
    )
    .join("\n");
  return `<table>
<thead><tr><th>Kind</th><th>Expected</th><th>Observed</th><th>Result</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function renderEvidence(evidence: TestCaseDetail["evidence"]): string {
  if (evidence.length === 0) {
    return `<p class="no-data">No evidence captured.</p>`;
  }
  const items = evidence
    .map((link) => `<li><a href="${escapeHtml(link.path)}">${escapeHtml(link.label)}</a> (${link.kind})</li>`)
    .join("\n");
  return `<ul class="evidence-list">${items}</ul>`;
}

function renderTestCases(testCases: TestCaseDetail[]): string {
  const cards = testCases
    .map((testCase) => {
      const recoveryCards = testCase.recoveryAttempts.map(renderRecoveryAttempt).join("\n");
      const checkpoints =
        testCase.checkpointsReached.length > 0
          ? testCase.checkpointsReached.map((checkpoint) => escapeHtml(checkpoint)).join(", ")
          : "None reached";
      return `<article class="case-card" id="case-${escapeHtml(testCase.caseId)}">
<div class="case-card-head">
<h3>${escapeHtml(testCase.title)}</h3>
${classificationBadge(testCase.classification)}
</div>
<p>${escapeHtml(testCase.goal)}</p>
<dl class="meta-grid">
<div class="meta-item"><dt>Confidence</dt><dd class="confidence">${escapeHtml(testCase.confidence)}</dd></div>
<div class="meta-item"><dt>Risk level</dt><dd>${escapeHtml(testCase.riskLevel)}</dd></div>
<div class="meta-item"><dt>Execution mode</dt><dd>${escapeHtml(testCase.executionMode)}</dd></div>
<div class="meta-item"><dt>Duration</dt><dd>${formatDuration(testCase.durationMs)}</dd></div>
<div class="meta-item"><dt>Attempts</dt><dd>${testCase.attempts}</dd></div>
<div class="meta-item"><dt>Checkpoints reached</dt><dd>${checkpoints}</dd></div>
</dl>
${recoveryCards ? `<h4>Recovery attempts</h4>${recoveryCards}` : ""}
<h4>Assertions</h4>
${renderAssertions(testCase.assertions)}
<h4>Evidence</h4>
${renderEvidence(testCase.evidence)}
<details>
<summary>Raw result (redacted)</summary>
<pre>${escapeHtml(JSON.stringify(testCase.redactedRawResult, null, 2))}</pre>
</details>
</article>`;
    })
    .join("\n");
  return `<section id="section-test-cases" aria-labelledby="test-cases-heading">
<h2 id="test-cases-heading">Test Case Detail</h2>
<div class="toolbar">
<button type="button" data-action="expand-all">Expand all raw results</button>
<button type="button" data-action="collapse-all">Collapse all raw results</button>
</div>
${cards || `<p class="no-data">No test cases were verified.</p>`}
</section>`;
}

function renderFindings(findings: Finding[]): string {
  const cards = findings
    .map((finding) => {
      const steps = finding.reproductionPath.map((step) => `<li>${escapeHtml(step)}</li>`).join("\n");
      return `<article class="finding-card" id="finding-${escapeHtml(finding.caseId)}">
<div class="case-card-head">
<h3>${escapeHtml(finding.title)}</h3>
${severityTag(finding.severity)}
${defectClassificationTag(finding.classification)}
</div>
<p><strong>Observed:</strong> ${escapeHtml(finding.observedBehavior)}</p>
<p><strong>Expected:</strong> ${escapeHtml(finding.expectedBehavior)}</p>
<p><strong>Affected checkpoint:</strong> ${escapeHtml(finding.affectedCheckpoint)}</p>
<p><strong>Recovery continued the run:</strong> ${finding.recoveryContinuedRun ? "Yes" : "No"}</p>
<h4>Reproduction path</h4>
<ol>${steps || `<li class="no-data">No reproduction steps recorded.</li>`}</ol>
<h4>Evidence</h4>
${renderEvidence(finding.evidence)}
</article>`;
    })
    .join("\n");
  return `<section id="section-findings" aria-labelledby="findings-heading">
<h2 id="findings-heading">Findings</h2>
${cards || `<p class="no-data">No defect findings for this run.</p>`}
</section>`;
}

function renderGovernance(governance: Governance): string {
  const auditRows = governance.redactedAuditTimeline
    .map(
      (entry) =>
        `<tr><td>${formatDateTime(entry.timestamp)}</td><td>${escapeHtml(entry.type)}</td><td>${escapeHtml(entry.actor)}</td><td><pre>${escapeHtml(JSON.stringify(entry.detail))}</pre></td></tr>`,
    )
    .join("\n");
  const transitionRows = governance.stateTransitions
    .map(
      (transition) =>
        `<tr><td>${escapeHtml(transition.from ?? "—")}</td><td>${escapeHtml(transition.to)}</td><td>${formatDateTime(transition.at)}</td></tr>`,
    )
    .join("\n");
  return `<section id="section-governance" aria-labelledby="governance-heading">
<h2 id="governance-heading">Governance</h2>
<dl class="meta-grid">
<div class="meta-item"><dt>Scope manifest version</dt><dd>${escapeHtml(governance.scopeManifestVersion)}</dd></div>
<div class="meta-item"><dt>Test plan</dt><dd>${escapeHtml(governance.testPlanId ?? "—")}${governance.testPlanVersion ? ` v${governance.testPlanVersion}` : ""}</dd></div>
<div class="meta-item"><dt>Approver</dt><dd>${escapeHtml(governance.approverName ?? "—")}</dd></div>
<div class="meta-item"><dt>Approval decision</dt><dd>${escapeHtml(governance.approvalDecision ?? "—")}</dd></div>
<div class="meta-item"><dt>Decided at</dt><dd>${formatDateTime(governance.approvalDecidedAt)}</dd></div>
<div class="meta-item"><dt>Execution policy</dt><dd>${escapeHtml(governance.executionPolicy)}</dd></div>
<div class="meta-item"><dt>Runtime versions</dt><dd>${escapeHtml(
    Object.entries(governance.runtimeVersions)
      .map(([name, version]) => `${name}@${version}`)
      .join(", "),
  )}</dd></div>
</dl>
<h3>State transitions</h3>
<table>
<thead><tr><th>From</th><th>To</th><th>At</th></tr></thead>
<tbody>${transitionRows || `<tr><td colspan="3" class="no-data">No state transitions recorded.</td></tr>`}</tbody>
</table>
<h3>Audit timeline</h3>
<table>
<thead><tr><th>Timestamp</th><th>Type</th><th>Actor</th><th>Detail</th></tr></thead>
<tbody>${auditRows || `<tr><td colspan="4" class="no-data">No audit events recorded.</td></tr>`}</tbody>
</table>
</section>`;
}

function renderFooter(footer: ReportData["footer"]): string {
  return `<footer class="report-footer" id="section-footer">
<p>Generated by Nova</p>
<p>Generated at ${formatDateTime(footer.generatedAt)} · Report version ${escapeHtml(footer.reportVersion)}</p>
<p>Integrity hash: ${footer.integrityHash ? escapeHtml(footer.integrityHash) : "Not yet signed"}</p>
</footer>`;
}

function renderScript(): string {
  return `<script>
(function () {
  function forEachDetails(fn) {
    document.querySelectorAll("#section-test-cases details").forEach(fn);
  }
  var expandButton = document.querySelector('[data-action="expand-all"]');
  var collapseButton = document.querySelector('[data-action="collapse-all"]');
  if (expandButton) {
    expandButton.addEventListener("click", function () {
      forEachDetails(function (node) { node.open = true; });
    });
  }
  if (collapseButton) {
    collapseButton.addEventListener("click", function () {
      forEachDetails(function (node) { node.open = false; });
    });
  }
})();
</script>`;
}
