import type { BrandConfig } from "../brand.js";
import type { RunRecord, RunStatus, Project } from "../domain.js";
import {
  escapeHtml,
  renderDiscoverySection,
  renderExecutionSection,
  renderPlanSection,
} from "../reporting/report.js";
import type { WorkflowResult } from "../workflow/harness-workflow.js";

// Visual language ported from the Nova dashboard design exploration
// (thaaaru/nova-dashboard-explorer): frosted-glass panels over an oklch
// token system, a persistent sidebar, and a breadcrumb-driven shell. Ported
// by hand into plain CSS — the dashboard stays a zero-build, server-rendered
// page with no framework runtime.
const PAGE_STYLE = `
  :root {
    --background: oklch(0.968 0.012 274);
    --foreground: oklch(0.205 0.036 265);
    --card: oklch(1 0 0);
    --muted-foreground: oklch(0.56 0.035 260);
    --primary: oklch(0.51 0.23 277);
    --primary-foreground: oklch(0.99 0.002 260);
    --accent: oklch(0.72 0.14 213);
    --accent-soft: oklch(0.72 0.14 213 / 14%);
    --border: oklch(0.91 0.016 270);
    --glass: oklch(1 0 0 / 62%);
    --glass-soft: oklch(1 0 0 / 42%);
    --glass-border: oklch(1 0 0 / 72%);
    --success: oklch(0.63 0.17 154);
    --warning: oklch(0.7 0.16 78);
    --destructive: oklch(0.577 0.245 27.325);
    --sidebar: oklch(0.984 0.003 247.858);
  }

  * { box-sizing: border-box; }

  body {
    font-family: "Inter", -apple-system, Helvetica, Arial, sans-serif;
    color: var(--foreground);
    background: var(--background);
    margin: 0;
    min-width: 768px;
  }

  code, .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }

  a { color: inherit; }

  .nova-wash {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background:
      radial-gradient(circle at 2% 4%, oklch(0.65 0.18 277 / 20%), transparent 27%),
      radial-gradient(circle at 96% 45%, oklch(0.72 0.14 213 / 18%), transparent 25%),
      radial-gradient(circle at 42% 100%, oklch(0.72 0.12 318 / 12%), transparent 25%);
  }

  .shell { position: relative; z-index: 1; display: flex; min-height: 100vh; }

  .sidebar {
    width: 15.5rem;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--glass-border);
    background: color-mix(in oklch, var(--sidebar) 70%, transparent);
    backdrop-filter: blur(28px);
  }

  .sidebar-brand { display: flex; align-items: center; gap: 0.65rem; padding: 1.15rem 1.4rem; }
  .sidebar-mark {
    display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: 0.5rem;
    background: var(--primary); color: var(--primary-foreground); font-size: 0.9rem; font-weight: 700;
    box-shadow: 0 10px 20px -12px oklch(0.51 0.23 277 / 60%);
  }
  .sidebar-brand-name { font-size: 0.9rem; font-weight: 600; line-height: 1.2; }
  .sidebar-brand-sub { font-size: 0.7rem; color: var(--muted-foreground); }

  .sidebar-nav { flex: 1; padding: 0.5rem 0.75rem; font-size: 0.85rem; }
  .sidebar-heading {
    padding: 0.25rem 0.75rem 0.35rem;
    font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--muted-foreground); margin-top: 0.75rem;
  }
  .sidebar-heading:first-child { margin-top: 0; }
  .sidebar-link, .sidebar-link-active {
    display: block; width: 100%; text-align: left; border-radius: 0.5rem; padding: 0.5rem 0.75rem;
    font-weight: 500; color: var(--muted-foreground); text-decoration: none; margin-bottom: 0.1rem;
  }
  .sidebar-link:hover { background: var(--glass); color: var(--foreground); }
  .sidebar-link-active { background: var(--glass); color: var(--primary); box-shadow: 0 1px 5px oklch(0.45 0.08 275 / 10%); }
  .sidebar-empty { padding: 0.35rem 0.75rem; font-size: 0.78rem; color: var(--muted-foreground); }

  .sidebar-safety {
    margin: 0.75rem; padding: 0.75rem; border-radius: 0.6rem;
    border: 1px solid var(--glass-border); background: var(--glass); backdrop-filter: blur(20px);
  }
  .sidebar-safety-title { display: flex; align-items: center; gap: 0.4rem; font-size: 0.72rem; font-weight: 600; }
  .sidebar-safety-title .dot { width: 0.4rem; height: 0.4rem; border-radius: 999px; background: var(--success); }
  .sidebar-safety p { margin: 0.35rem 0 0; font-size: 0.68rem; line-height: 1.4; color: var(--muted-foreground); }

  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }

  .topbar {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    min-height: 3.5rem; padding: 0 1.5rem; border-bottom: 1px solid var(--glass-border);
    background: var(--glass-soft); backdrop-filter: blur(28px);
  }
  .breadcrumb { display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; color: var(--muted-foreground); }
  .breadcrumb a { text-decoration: none; }
  .breadcrumb a:hover { color: var(--foreground); }
  .breadcrumb .sep { opacity: 0.5; }
  .breadcrumb .current { color: var(--foreground); font-weight: 600; }

  .content { flex: 1; padding: 1.5rem 2rem 3rem; max-width: 1100px; }

  h1 { margin: 0; font-size: 1.5rem; font-weight: 600; }
  h2 { margin: 0 0 0.75rem; font-size: 0.95rem; font-weight: 600; border-bottom: none; padding-bottom: 0; }
  .page-header { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
  .page-lede { color: var(--muted-foreground); margin-top: 0.35rem; font-size: 0.9rem; }
  .meta { color: var(--muted-foreground); margin-bottom: 1.25rem; font-size: 0.9rem; }

  section { margin-bottom: 1.5rem; }

  .glass-panel {
    border: 1px solid var(--glass-border); border-radius: 0.75rem; background: var(--glass);
    padding: 1.25rem; box-shadow: 0 18px 45px -32px oklch(0.35 0.06 270 / 45%); backdrop-filter: blur(24px);
  }

  .badge, .status-badge {
    display: inline-flex; align-items: center; gap: 0.4rem;
    padding: 0.25rem 0.7rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600;
  }
  .status-badge .dot { width: 0.375rem; height: 0.375rem; border-radius: 999px; background: currentColor; }
  .badge.passed, .status-badge.passed { background: oklch(0.63 0.17 154 / 12%); color: oklch(0.46 0.15 154); }
  .badge.failed, .status-badge.failed { background: oklch(0.62 0.21 25 / 12%); color: oklch(0.52 0.19 25); }
  .badge.default, .status-badge.default { background: oklch(0.93 0.01 260); color: var(--muted-foreground); }
  .badge.read_only { background: var(--accent-soft); color: oklch(0.52 0.14 213); }
  .badge.session_change { background: oklch(0.7 0.16 78 / 14%); color: oklch(0.5 0.14 70); }
  .badge.state_change { background: oklch(0.62 0.21 25 / 12%); color: oklch(0.52 0.19 25); }
  .status-badge.pending { background: oklch(0.7 0.16 78 / 14%); color: oklch(0.5 0.14 70); }
  .status-badge.approved { background: oklch(0.63 0.17 154 / 12%); color: oklch(0.46 0.15 154); }
  .status-badge.rejected { background: oklch(0.62 0.21 25 / 12%); color: oklch(0.52 0.19 25); }
  .status-badge.session-tag { background: var(--accent-soft); color: oklch(0.52 0.14 213); font-weight: 500; }

  .card { border: 1px solid var(--glass-border); border-radius: 0.65rem; background: var(--glass-soft); padding: 1rem; margin-bottom: 1rem; }
  .errors { color: oklch(0.52 0.19 25); font-size: 0.9rem; }
  img.screenshot { max-width: 100%; border: 1px solid var(--glass-border); border-radius: 0.5rem; margin-top: 0.5rem; }

  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.88rem; }
  th { color: var(--muted-foreground); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.02em; }
  tbody tr:hover td { background: var(--glass); }
  tbody tr:last-child td { border-bottom: none; }
  a.run-link { color: var(--primary); text-decoration: none; font-weight: 600; }
  a.run-link:hover { text-decoration: underline; }

  .actions { margin: 1.25rem 0; display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; }
  .actions form { display: flex; gap: 0.5rem; align-items: center; }

  button {
    display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;
    font-size: 0.875rem; font-weight: 600; padding: 0.55rem 1.1rem; border-radius: 0.5rem;
    border: 1px solid transparent; cursor: pointer;
  }
  button.execute {
    background: var(--primary); color: var(--primary-foreground);
    box-shadow: 0 9px 20px -12px oklch(0.51 0.23 277 / 70%);
  }
  button.execute:hover { opacity: 0.92; }
  button.approve { background: var(--success); color: white; }
  button.approve:hover { opacity: 0.92; }
  button.reject { background: transparent; color: oklch(0.52 0.19 25); border-color: oklch(0.62 0.21 25 / 35%); }
  button.reject:hover { background: oklch(0.62 0.21 25 / 8%); }
  button:disabled { opacity: 0.5; cursor: default; }

  label { display: block; margin: 0.85rem 0 0.3rem; font-size: 0.82rem; font-weight: 500; color: var(--foreground); }
  input[type="text"], input[type="url"], input[type="number"], select {
    padding: 0.5rem 0.65rem; width: 100%; max-width: 420px; box-sizing: border-box;
    border: 1px solid var(--border); border-radius: 0.5rem; background: var(--card); font-size: 0.9rem;
  }
  input:focus, select:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px oklch(0.51 0.23 277 / 12%); }
  input[type="checkbox"] { width: auto; margin-right: 0.4rem; }
  form.card { max-width: 520px; }
  .hint { color: var(--muted-foreground); font-size: 0.82rem; }
  .empty-state { color: var(--muted-foreground); font-size: 0.9rem; padding: 1rem 0; }

  #status { margin-top: 1rem; font-weight: 600; }
  #log { list-style: none; margin: 1rem 0; padding: 0; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 0.85rem; }
  #log li {
    display: flex; align-items: center; gap: 0.5rem; border-radius: 0.5rem;
    background: var(--glass-soft); padding: 0.6rem 0.75rem; margin-bottom: 0.4rem;
  }
  #log li.pass { color: oklch(0.46 0.15 154); }
  #log li.fail { color: oklch(0.52 0.19 25); }
  .completion.glass-panel { margin-top: 1rem; }
  .completion a { display: inline-block; margin-right: 1rem; font-weight: 600; color: var(--primary); text-decoration: none; }
  .completion a:hover { text-decoration: underline; }
`;

const PRODUCT_MARK_FALLBACK = "N";

function sidebar(brand: BrandConfig, projects: Project[], activeProjectId?: string): string {
  const mark = escapeHtml(brand.productName.slice(0, 1).toUpperCase() || PRODUCT_MARK_FALLBACK);

  const projectItems =
    projects.length === 0
      ? `<p class="sidebar-empty">No projects yet.</p>`
      : projects
          .map((project) => {
            const active = project.id === activeProjectId;
            return `<a class="${active ? "sidebar-link-active" : "sidebar-link"}" href="/">${escapeHtml(project.name)}</a>`;
          })
          .join("");

  return `
  <aside class="sidebar">
    <div class="sidebar-brand">
      <div class="sidebar-mark">${mark}</div>
      <div>
        <div class="sidebar-brand-name">${escapeHtml(brand.productName)}</div>
        <div class="sidebar-brand-sub">Read-only testing</div>
      </div>
    </div>
    <nav class="sidebar-nav">
      <p class="sidebar-heading">Projects</p>
      ${projectItems}
    </nav>
    <div class="sidebar-safety">
      <div class="sidebar-safety-title"><span class="dot"></span>Read-only mode</div>
      <p>No clicks, form fills, or submissions are ever performed.</p>
    </div>
  </aside>`;
}

function breadcrumb(trail: Array<{ label: string; href?: string }>): string {
  const parts = trail
    .map((step, index) => {
      const isLast = index === trail.length - 1;
      const label = escapeHtml(step.label);
      const node =
        step.href && !isLast
          ? `<a href="${escapeHtml(step.href)}">${label}</a>`
          : `<span class="current">${label}</span>`;
      return index === 0 ? node : `<span class="sep">/</span>${node}`;
    })
    .join("");
  return `<nav class="breadcrumb">${parts}</nav>`;
}

function shell(
  brand: BrandConfig,
  title: string,
  trail: Array<{ label: string; href?: string }>,
  body: string,
  projects: Project[] = [],
  activeProjectId?: string,
): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(brand.productName)} — ${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="nova-wash" aria-hidden="true"></div>
<div class="shell">
  ${sidebar(brand, projects, activeProjectId)}
  <div class="main">
    <header class="topbar">
      ${breadcrumb(trail)}
      <a class="hint" style="text-decoration:none" href="/login">Capture a login session</a>
    </header>
    <main class="content">${body}</main>
  </div>
</div>
</body>
</html>`;
}

const RUN_STATUS_META: Record<RunStatus, { label: string; klass: string }> = {
  discovering: { label: "Discovering", klass: "default" },
  planning: { label: "Planning", klass: "default" },
  awaiting_approval: { label: "Awaiting approval", klass: "pending" },
  ready_to_execute: { label: "Ready to execute", klass: "approved" },
  executing: { label: "Executing", klass: "approved" },
  passed: { label: "Passed", klass: "passed" },
  rejected: { label: "Rejected", klass: "rejected" },
  failed: { label: "Failed", klass: "failed" },
};

function runStatusBadge(status: RunStatus): string {
  const meta = RUN_STATUS_META[status];
  return `<span class="status-badge ${meta.klass}"><span class="dot"></span>${escapeHtml(meta.label)}</span>`;
}

export function renderHomePage(runs: RunRecord[], projects: Project[], brand: BrandConfig): string {
  const rows = runs
    .map(
      (run) => `<tr>
        <td><a class="run-link" href="/runs/${escapeHtml(run.id)}">${escapeHtml(run.targetUrl)}</a></td>
        <td>${runStatusBadge(run.status)}</td>
        <td><span class="status-badge session-tag">${run.input.storageStatePath ? "🔒 authenticated" : "🌐 anonymous"}</span></td>
        <td>${escapeHtml(new Date(run.createdAt).toLocaleString())}</td>
      </tr>`,
    )
    .join("");

  const projectOptions = projects
    .map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`)
    .join("");

  const body = `
  <div class="page-header">
    <div>
      <h1>Scans</h1>
      <p class="page-lede">Discover, review, approve, and execute governed read-only scans.</p>
    </div>
  </div>

  <section class="glass-panel">
    <h2>Recent scans</h2>
    ${
      runs.length === 0
        ? `<p class="empty-state">No scans yet — start one below.</p>`
        : `<table>
            <thead><tr><th>Target</th><th>Status</th><th>Session</th><th>Started</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
    }
  </section>

  <section class="glass-panel">
    <h2>Start a new scan</h2>
    <form method="post" action="/runs">
      <label for="targetUrl">Application URL</label>
      <input type="url" id="targetUrl" name="targetUrl" placeholder="https://example.test" required>

      <label for="goal">Goal (optional — defaults to the governed baseline)</label>
      <input type="text" id="goal" name="goal" placeholder="web-app-baseline">

      <label for="storageStatePath">Storage state file (optional — for an authenticated scan)</label>
      <input type="text" id="storageStatePath" name="storageStatePath" placeholder="auth/example.json">
      <div class="hint">Don't have one yet? <a href="/login">Capture a login session</a> first.</div>

      <label for="maxPages">Max pages to inspect</label>
      <input type="number" id="maxPages" name="maxPages" value="10" min="1" max="50">

      <label><input type="checkbox" name="allowInsecureHttp" value="true"> Allow plain HTTP (local/isolated targets only)</label>

      <label><input type="checkbox" name="allowInteractions" value="true"> Allow interactions (click/fill/select) — reviewed and denylist-filtered before running, but not read-only</label>

      ${
        projects.length > 0
          ? `<label for="projectId">Project (optional)</label>
             <select id="projectId" name="projectId">
               <option value="">— none —</option>
               ${projectOptions}
             </select>`
          : ""
      }

      <div class="actions">
        <button class="execute" type="submit">Start discovery</button>
      </div>
    </form>
  </section>`;

  return shell(
    brand,
    "dashboard",
    [{ label: brand.productName, href: "/" }, { label: "Scans" }],
    body,
    projects,
  );
}

export function renderRunPage(result: WorkflowResult, run: RunRecord, brand: BrandConfig): string {
  const sections = `
    ${result.plan ? renderPlanSection(result.plan) : ""}
    ${result.snapshot ? renderDiscoverySection(result.snapshot) : ""}
    ${result.execution ? renderExecutionSection(result.execution) : ""}`;

  const header = `
  <div class="page-header">
    <div>
      <h1>${escapeHtml(run.targetUrl)}</h1>
      <div class="meta">
        Run <code>${escapeHtml(run.id)}</code>
      </div>
    </div>
    ${runStatusBadge(run.status)}
  </div>
  <div class="meta">
    <span class="status-badge session-tag">
      ${run.input.storageStatePath ? `🔒 authenticated (<code>${escapeHtml(run.input.storageStatePath)}</code>)` : "🌐 anonymous"}
    </span>
  </div>`;

  const canRetryExecution = run.status === "failed" && run.approval?.decision === "approved";

  let actions = "";
  if (run.status === "awaiting_approval") {
    actions = `
    <div class="actions">
      <form method="post" action="/runs/${escapeHtml(run.id)}/approve">
        <input type="text" name="approver" placeholder="Your name" required>
        <button class="approve" type="submit">Approve</button>
      </form>
      <form method="post" action="/runs/${escapeHtml(run.id)}/reject">
        <input type="text" name="approver" placeholder="Your name" required>
        <button class="reject" type="submit">Reject</button>
      </form>
    </div>`;
  } else if (run.status === "ready_to_execute" || canRetryExecution) {
    actions = `
    <div class="actions">
      <button class="execute" id="execute-button" onclick="runExecute('${escapeHtml(run.id)}')">${
        canRetryExecution ? "Retry execution" : "Execute now"
      }</button>
    </div>
    <ul id="log"></ul>
    <div id="completion"></div>
    <script>
      function runExecute(runId) {
        document.getElementById('execute-button').disabled = true;
        const log = document.getElementById('log');
        const source = new EventSource('/runs/' + runId + '/execute-stream');

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
            '<div class="completion glass-panel"><strong>' + banner + '</strong> \\u2014 ' + data.passed + ' of ' + data.total + ' check(s) passed.'
            + '<div style="margin-top: 1rem;">'
            + '<a href="/runs/' + runId + '/report.html" target="_blank">View full report</a>'
            + '<a href="/runs/' + runId + '/report.pdf" target="_blank">Download PDF</a>'
            + '</div></div>';
        });

      }
    </script>`;
  } else if (run.status === "passed" || (run.status === "failed" && result.execution)) {
    actions = `
    <div class="actions">
      <a class="run-link" href="/runs/${escapeHtml(run.id)}/report.html" target="_blank">View full report</a>
      &nbsp;·&nbsp;
      <a class="run-link" href="/runs/${escapeHtml(run.id)}/report.pdf" target="_blank">Download PDF</a>
    </div>`;
  } else if (run.status === "rejected") {
    actions = `<p class="hint">This plan was rejected before any checks ran.</p>`;
  } else {
    actions = `<p class="hint">This run is still ${escapeHtml(run.status)} — refresh in a moment.</p>`;
  }

  return shell(
    brand,
    run.targetUrl,
    [{ label: brand.productName, href: "/" }, { label: "Scans", href: "/" }, { label: run.targetUrl }],
    `${header}${actions}${sections}`,
  );
}

export function renderLoginPage(brand: BrandConfig, error?: string): string {
  const body = `
  <div class="page-header">
    <div>
      <h1>Capture a login session</h1>
      <p class="page-lede">
        A headed browser opens on the URL below. Log in however the app requires
        (password, MFA, SSO), then come back here and confirm. ${escapeHtml(brand.productName)} never
        sees your credentials — only the resulting session is saved.
      </p>
    </div>
  </div>
  ${error ? `<p class="errors">${escapeHtml(error)}</p>` : ""}
  <section class="glass-panel">
    <form method="post" action="/login">
      <label for="url">Login URL</label>
      <input type="url" id="url" name="url" placeholder="https://example.test/login" required>

      <label for="outputPath">Save storage state to</label>
      <input type="text" id="outputPath" name="outputPath" placeholder="auth/example.json" required>

      <div class="actions">
        <button class="execute" type="submit">Open browser to log in</button>
      </div>
    </form>
  </section>`;

  return shell(
    brand,
    "capture a login session",
    [{ label: brand.productName, href: "/" }, { label: "Login session" }],
    body,
  );
}

export function renderLoginPendingPage(brand: BrandConfig, outputPath: string): string {
  const body = `
  <div class="page-header">
    <div>
      <h1>Log in in the browser window</h1>
      <p class="page-lede">
        A browser window opened. Once you have logged in and can see the
        authenticated application, come back here and confirm.
      </p>
    </div>
  </div>
  <section class="glass-panel">
    <form method="post" action="/login/confirm">
      <input type="hidden" name="outputPath" value="${escapeHtml(outputPath)}">
      <div class="actions">
        <button class="approve" type="submit">I'm logged in — save the session</button>
      </div>
    </form>
    <form method="post" action="/login/cancel">
      <button class="reject" type="submit">Cancel</button>
    </form>
  </section>`;

  return shell(
    brand,
    "logging in",
    [{ label: brand.productName, href: "/" }, { label: "Login session" }],
    body,
  );
}

export function renderLoginSavedPage(brand: BrandConfig, outputPath: string): string {
  const body = `
  <div class="page-header">
    <div>
      <h1>Session saved</h1>
      <p class="page-lede">Storage state written to <code>${escapeHtml(outputPath)}</code>.</p>
    </div>
  </div>
  <p>Use it on the <a class="run-link" href="/">dashboard</a> to start an authenticated scan.</p>`;

  return shell(
    brand,
    "session saved",
    [{ label: brand.productName, href: "/" }, { label: "Login session" }],
    body,
  );
}
