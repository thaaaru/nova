import type { BrandConfig } from "../brand.js";
import { escapeHtml, renderDiscoverySection, renderPlanSection } from "../reporting/report.js";
import type { WorkflowResult } from "../workflow/harness-workflow.js";

const PAGE_STYLE = `
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 2rem; max-width: 900px; }
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
  .actions { margin: 1.5rem 0; }
  button { font-size: 1rem; padding: 0.6rem 1.4rem; border-radius: 6px; border: none; cursor: pointer; margin-right: 0.75rem; }
  button.approve { background: #166534; color: white; }
  button.reject { background: #991b1b; color: white; }
  button.execute { background: #1e3a8a; color: white; }
  button:disabled { opacity: 0.5; cursor: default; }
  label { display: block; margin: 0.5rem 0 0.25rem; font-size: 0.9rem; color: #333; }
  input[type="text"] { padding: 0.4rem; width: 100%; max-width: 320px; box-sizing: border-box; }
  #status { margin-top: 1rem; font-weight: 600; }
  #log { list-style: none; margin: 1rem 0; padding: 0; font-family: ui-monospace, monospace; font-size: 0.9rem; }
  #log li { padding: 0.25rem 0; }
  #log li.pass { color: #166534; }
  #log li.fail { color: #991b1b; }
  .completion { border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; margin-top: 1rem; }
  .completion a { display: inline-block; margin-right: 1rem; font-weight: 600; }
`;

function page(title: string, brand: BrandConfig, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(brand.productName)} — ${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

export function renderReviewPage(result: WorkflowResult, brand: BrandConfig): string {
  const body = `
  <h1>${escapeHtml(brand.productName)} — review this test plan</h1>
  <div class="meta">Run <code>${escapeHtml(result.runId)}</code></div>
  ${result.plan ? renderPlanSection(result.plan) : ""}
  ${result.snapshot ? renderDiscoverySection(result.snapshot) : ""}
  <div class="actions">
    <label for="approver">Your name</label>
    <input type="text" id="approver" placeholder="Jane Doe">
    <div class="actions">
      <button class="approve" onclick="decide('approve')">Approve</button>
      <button class="reject" onclick="decide('reject')">Reject</button>
    </div>
    <div id="status"></div>
  </div>
  <script>
    async function decide(action) {
      const approver = document.getElementById('approver').value || 'QA reviewer';
      document.getElementById('status').textContent = 'Working…';
      const response = await fetch('/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approver }),
      });
      document.open();
      document.write(await response.text());
      document.close();
    }
  </script>`;

  return page("review this run", brand, body);
}

export function renderApprovedPage(result: WorkflowResult, brand: BrandConfig): string {
  const body = `
  <h1>Approved</h1>
  <div class="meta">Run <code>${escapeHtml(result.runId)}</code> is ready to execute.</div>
  <div class="actions">
    <button class="execute" id="execute-button" onclick="runExecute()">Execute now</button>
  </div>
  <ul id="log"></ul>
  <div id="completion"></div>
  <script>
    function runExecute() {
      document.getElementById('execute-button').disabled = true;
      const log = document.getElementById('log');
      const source = new EventSource('/execute-stream');

      source.addEventListener('check-start', (event) => {
        const data = JSON.parse(event.data);
        const item = document.createElement('li');
        item.textContent = 'Checking ' + data.url + ' …';
        log.appendChild(item);
      });

      source.addEventListener('check-complete', (event) => {
        const data = JSON.parse(event.data);
        const item = document.createElement('li');
        item.className = data.status === 'passed' ? 'pass' : 'fail';
        item.textContent = (data.status === 'passed' ? '\\u2713 ' : '\\u2717 ') + data.url + ' \\u2014 ' + data.status
          + (data.error ? ': ' + data.error : '');
        log.appendChild(item);
      });

      source.addEventListener('done', (event) => {
        const data = JSON.parse(event.data);
        source.close();
        const banner = data.status === 'passed' ? '\\u2705 Test completed' : '\\u26a0\\ufe0f Test completed with failures';
        document.getElementById('completion').innerHTML =
          '<div class="completion"><strong>' + banner + '</strong> \\u2014 ' + data.passed + ' of ' + data.total + ' check(s) passed.'
          + '<div style="margin-top: 1rem;">'
          + '<a href="/report.html" target="_blank">View full report</a>'
          + '<a href="/report.pdf" target="_blank">Download PDF</a>'
          + '</div></div>';
      });
    }
  </script>`;

  return page("approved", brand, body);
}

export function renderRejectedPage(result: WorkflowResult, brand: BrandConfig): string {
  return page(
    "rejected",
    brand,
    `<h1>Rejected</h1><div class="meta">Run <code>${escapeHtml(result.runId)}</code> was rejected. No checks were executed.</div>`,
  );
}
