import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

import type { BrandConfig } from "../brand.js";
import type { ExecutionResult } from "../domain.js";
import type { WorkflowResult } from "../workflow/harness-workflow.js";

export function renderReportHtml(result: WorkflowResult, brand: BrandConfig): string {
  const { runId, status, plan, snapshot, execution } = result;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(brand.productName)} test report — ${escapeHtml(runId)}</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 2rem; }
  h1 { margin-bottom: 0.25rem; }
  .meta { color: #555; margin-bottom: 1.5rem; }
  .badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
  .badge.passed { background: #dcfce7; color: #166534; }
  .badge.failed { background: #fee2e2; color: #991b1b; }
  .badge.default { background: #e5e7eb; color: #374151; }
  .badge.read_only { background: #dbeafe; color: #1e3a8a; }
  .badge.session_change { background: #fef3c7; color: #92400e; }
  .badge.state_change { background: #fee2e2; color: #991b1b; }
  section { margin-bottom: 2.5rem; }
  h2 { border-bottom: 1px solid #ddd; padding-bottom: 0.4rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .errors { color: #991b1b; font-size: 0.9rem; }
  img.screenshot { max-width: 100%; border: 1px solid #ddd; border-radius: 4px; margin-top: 0.5rem; }
  code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 3px; }
  .lh-scores { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
  .lh-score { border-radius: 8px; padding: 0.75rem 1.25rem; min-width: 100px; text-align: center; }
  .lh-score .value { font-size: 1.6rem; font-weight: 700; display: block; }
  .lh-score.good { background: #dcfce7; color: #166534; }
  .lh-score.average { background: #fef3c7; color: #92400e; }
  .lh-score.poor { background: #fee2e2; color: #991b1b; }
  .lh-finding { border-left: 3px solid #d97706; padding-left: 0.75rem; margin-bottom: 0.75rem; }
  .lh-finding .category { color: #6b7280; font-size: 0.8rem; text-transform: uppercase; }
</style>
</head>
<body>
  <h1>${escapeHtml(brand.productName)} test report</h1>
  <div class="meta">
    Run <code>${escapeHtml(runId)}</code> &middot; ${statusBadge(status)} &middot; generated ${escapeHtml(new Date().toISOString())}
  </div>
  ${plan ? renderPlanSection(plan) : ""}
  ${snapshot ? renderDiscoverySection(snapshot) : ""}
  ${execution ? renderExecutionSection(execution) : ""}
</body>
</html>`;
}

export async function renderReportPdf(html: string, outputPath: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: outputPath, format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
}

export type WrittenReport = { htmlPath: string; pdfPath: string };

/** Renders and writes both report files for a run to `outputDir`. */
export async function writeReportFiles(
  result: WorkflowResult,
  brand: BrandConfig,
  outputDir: string,
): Promise<WrittenReport> {
  mkdirSync(outputDir, { recursive: true });
  const html = renderReportHtml(result, brand);
  const htmlPath = join(outputDir, "report.html");
  writeFileSync(htmlPath, html);
  const pdfPath = join(outputDir, "report.pdf");
  await renderReportPdf(html, pdfPath);
  return { htmlPath, pdfPath };
}

export function renderPlanSection(plan: NonNullable<WorkflowResult["plan"]>): string {
  const steps = plan.steps
    .map(
      (step) => `
    <div class="card">
      <strong>${escapeHtml(step.title)}</strong>
      ${riskBadge(step.risk)}
      ${step.requiresApproval ? '<span class="badge default">requires approval</span>' : ""}
      <p>${escapeHtml(step.rationale)}</p>
      <ul>${step.actions.map((action) => `<li>${renderAction(action)}</li>`).join("")}</ul>
      <p><em>Expected:</em> ${escapeHtml(step.expectedResult)}</p>
    </div>`,
    )
    .join("");

  const warnings =
    plan.warnings.length > 0 ? `<p class="errors">${plan.warnings.map(escapeHtml).join("; ")}</p>` : "";

  return `
  <section>
    <h2>Test plan</h2>
    <p>${escapeHtml(plan.summary)}</p>
    ${warnings}
    ${steps}
  </section>`;
}

function renderAction(
  action: NonNullable<WorkflowResult["plan"]>["steps"][number]["actions"][number],
): string {
  const badge = `<span class="badge default">${escapeHtml(action.kind)}</span>`;
  if (action.kind !== "interact" || !action.target) {
    return `${badge} ${escapeHtml(action.description)}`;
  }
  const target = action.target;
  const name = target.label ?? target.name ?? "(unnamed)";
  const value = action.value ? ` with <code>${escapeHtml(action.value)}</code>` : "";
  return `${badge} ${escapeHtml(action.description)} — <code>${escapeHtml(target.kind)} "${escapeHtml(name)}"</code> on <code>${escapeHtml(target.page)}</code>${value}`;
}

export function renderDiscoverySection(snapshot: NonNullable<WorkflowResult["snapshot"]>): string {
  const pages = snapshot.pages
    .map((page) => {
      const errors = [...page.consoleErrors, ...page.pageErrors];
      return `
    <div class="card">
      <strong>${escapeHtml(page.title)}</strong> — <code>${escapeHtml(page.url)}</code>
      <p>Headings: ${page.headings.map(escapeHtml).join(", ") || "(none)"}</p>
      <p>${page.controls.length} control(s) discovered</p>
      ${errors.length > 0 ? `<p class="errors">${errors.length} console/page error(s): ${errors.map(escapeHtml).join("; ")}</p>` : ""}
      ${screenshotImg(page.screenshotPath)}
    </div>`;
    })
    .join("");

  return `
  <section>
    <h2>Discovery</h2>
    ${pages}
  </section>`;
}

export function renderExecutionSection(execution: NonNullable<WorkflowResult["execution"]>): string {
  const checks = execution.checks
    .map(
      (check) => `
    <div class="card">
      ${statusBadge(check.status)} <code>${escapeHtml(check.url)}</code>
      <p>Title: expected "${escapeHtml(check.expectedTitle)}", observed "${escapeHtml(check.observedTitle ?? "—")}"</p>
      ${check.expectedHeading ? `<p>Heading: expected "${escapeHtml(check.expectedHeading)}", observed "${escapeHtml(check.observedHeading ?? "—")}"</p>` : ""}
      ${check.error ? `<p class="errors">${escapeHtml(check.error)}</p>` : ""}
      ${screenshotImg(check.screenshotPath)}
    </div>`,
    )
    .join("");

  const interactions = execution.interactions
    .map(
      (interaction) => `
    <div class="card">
      ${statusBadge(interaction.status)} ${escapeHtml(interaction.description)}
      ${interaction.observedUrl ? `<p>Ended at <code>${escapeHtml(interaction.observedUrl)}</code></p>` : ""}
      ${interaction.error ? `<p class="errors">${escapeHtml(interaction.error)}</p>` : ""}
      ${screenshotImg(interaction.screenshotPath)}
    </div>`,
    )
    .join("");

  return `
  <section>
    <h2>Execution results</h2>
    ${statusBadge(execution.status)}
    ${checks}
    ${interactions.length > 0 ? `<h3>Interactions</h3>${interactions}` : ""}
    ${execution.lighthouse ? renderLighthouseSection(execution.lighthouse) : ""}
  </section>`;
}

function renderLighthouseSection(lighthouse: NonNullable<ExecutionResult["lighthouse"]>): string {
  const scores = lighthouse.categories
    .map((category) => {
      const percent = category.score === null ? null : Math.round(category.score * 100);
      const klass =
        percent === null ? "average" : percent >= 90 ? "good" : percent >= 50 ? "average" : "poor";
      return `
    <div class="lh-score ${klass}">
      <span class="value">${percent === null ? "—" : percent}</span>
      ${escapeHtml(category.title)}
    </div>`;
    })
    .join("");

  const findings = lighthouse.findings
    .map(
      (finding) => `
    <div class="lh-finding">
      <div class="category">${escapeHtml(finding.category)}</div>
      <strong>${escapeHtml(finding.title)}</strong>
      <p>${renderMarkdownLinks(finding.description)}</p>
    </div>`,
    )
    .join("");

  return `
  <div class="card">
    <h3>Lighthouse audit</h3>
    <div class="lh-scores">${scores}</div>
    ${findings || "<p>No significant findings.</p>"}
  </div>`;
}

// Lighthouse audit descriptions embed simple `[text](url)` Markdown links
// (documented behavior, not free-form Markdown) — render just that pattern
// as a real link instead of showing the literal bracket syntax.
function renderMarkdownLinks(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`,
  );
}

function screenshotImg(screenshotPath: string | undefined): string {
  if (!screenshotPath || !existsSync(screenshotPath)) {
    return "";
  }
  const base64 = readFileSync(screenshotPath).toString("base64");
  return `<img class="screenshot" src="data:image/png;base64,${base64}" alt="screenshot">`;
}

export function statusBadge(status: string): string {
  const klass =
    status === "passed" ? "passed" : status === "failed" || status === "rejected" ? "failed" : "default";
  return `<span class="badge ${klass}">${escapeHtml(status)}</span>`;
}

function riskBadge(risk: string): string {
  return `<span class="badge ${escapeHtml(risk)}">${escapeHtml(risk)}</span>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
