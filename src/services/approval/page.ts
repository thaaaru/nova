import type { SuggestedTestCase, TestRunState } from "../../domain/index.js";

/**
 * Nova's own approval page. Everything is inline and self-contained:
 * no remote script, stylesheet, font, image or analytics, so the page
 * works with a strict Content-Security-Policy and leaks nothing about
 * the run to any third party. It is a presentation layer only — the page
 * can propose a decision, never record one.
 *
 * No credential, cookie, token, session path, or model prompt is
 * rendered here. The CSRF token is the single value the page must carry
 * to talk back to the loopback server it was served from.
 */

export type RenderApprovalPageOptions = {
  run: TestRunState;
  csrfToken: string;
  nonce: string;
  postPath: string;
};

export function renderApprovalPage(options: RenderApprovalPageOptions): string {
  const { run, csrfToken, nonce, postPath } = options;
  const plan = run.testPlan;
  const suggestions = run.suggestions?.accepted ?? [];
  const rejected = run.suggestions?.rejected ?? [];
  const identification = run.identification?.identification;
  const snapshot = run.discoverySnapshot;

  const rows = suggestions.map((suggestion) => renderRow(suggestion)).join("\n");
  const facts: Array<[string, string]> = [
    ["Application", identification?.applicationName ?? run.targetManifest.targetId],
    ["Type", identification?.applicationType ?? "—"],
    ["Purpose", identification?.primaryPurpose ?? "—"],
    ["Target", run.targetManifest.baseUrl],
    ["Environment", run.targetManifest.environment],
    ["Scope", run.targetManifest.allowedDomains.join(", ")],
    ["Execution ceiling", run.targetManifest.runExecutionMode],
    ["Authentication", authenticationLabel(run)],
    ["Personas", (identification?.likelyPersonas ?? []).map((entry) => entry.name).join(", ") || "—"],
    ["Discovery snapshot", snapshot ? `${snapshot.pages.length} page(s) at ${snapshot.capturedAt}` : "—"],
    ["Plan ID", plan?.id ?? "—"],
    ["Plan hash", run.planHash ?? "—"],
    [
      "Identification confidence",
      identification
        ? `${Math.round(identification.confidence * 100)}% (${run.identification?.source})`
        : "—",
    ],
    ["Assumptions", (identification?.assumptions ?? []).join(" · ") || "—"],
  ];

  const discovery: Array<[string, string]> = [
    ["Areas", String(new Set(suggestions.map((entry) => entry.area)).size)],
    ["Journeys", String(new Set(suggestions.map((entry) => entry.journey)).size)],
    ["Routes / pages", String(snapshot?.pages.length ?? 0)],
    ["API operations", String(snapshot?.apiEndpoints.length ?? 0)],
    ["Documents", String((identification?.relevantDocuments ?? []).length)],
    ["Unknowns", String((identification?.unknowns ?? []).length)],
    ["Discovery gaps", String(rejected.length)],
    ["Evidence items", String(run.evidencePackage?.items.length ?? 0)],
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Approve test plan</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; --fg:#111; --muted:#5b6472; --bg:#fbfbfd; --card:#fff; --line:#d9dee6; --accent:#0b6fb8; }
@media (prefers-color-scheme: dark){ :root{ --fg:#e8ecf2; --muted:#9aa5b4; --bg:#12151a; --card:#1a1f27; --line:#2b3340; --accent:#59b0ee; } }
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:24px 0 8px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:16px}
dl{display:grid;grid-template-columns:200px 1fr;gap:6px 16px;margin:0}
dt{color:var(--muted)} dd{margin:0;word-break:break-word}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
tr.detail td{background:transparent;color:var(--muted);font-size:13px}
.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:12px}
.tag.mutates{border-color:#b8860b;color:#b8860b}
.tag.elevated{border-color:#b33;color:#b33}
button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
select,textarea{font:inherit;padding:6px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
textarea{width:100%;min-height:70px}
#result{margin-top:12px;font-weight:600}
.hidden{display:none}
</style>
</head>
<body>
<h1>Nova — approve test plan</h1>
<p class="muted">Approving records an immutable decision. It does <strong>not</strong> run anything: Nova asks for execution separately, back in the terminal.</p>

<h2>Application context</h2>
<div class="card"><dl>${facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl></div>

<h2>Discovery summary</h2>
<div class="card"><dl>${discovery.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl></div>

<h2>Test review</h2>
<div class="card">
  <div class="filters">
    <select id="f-area"><option value="">All areas</option>${uniqueOptions(suggestions.map((s) => s.area))}</select>
    <select id="f-persona"><option value="">All personas</option>${uniqueOptions(suggestions.map((s) => s.persona ?? "none"))}</select>
    <select id="f-type"><option value="">All types</option>${uniqueOptions(suggestions.map((s) => s.testType))}</select>
    <select id="f-priority"><option value="">All priorities</option>${uniqueOptions(suggestions.map((s) => s.priority))}</select>
    <select id="f-side"><option value="">All side effects</option>${uniqueOptions(suggestions.map((s) => s.sideEffect))}</select>
    <select id="f-source"><option value="">All sources</option>${uniqueOptions(suggestions.map((s) => s.source))}</select>
  </div>
  <table>
    <thead><tr><th></th><th>ID</th><th>Area</th><th>Journey</th><th>Persona</th><th>Test</th><th>Type</th><th>Priority</th><th>Side effect</th><th>Source</th></tr></thead>
    <tbody id="rows">
${rows}
    </tbody>
  </table>
  <div class="actions">
    <button id="select-safe" type="button">Select all safe tests</button>
    <button id="select-all" type="button">Select all</button>
    <button id="clear" type="button">Clear selection</button>
  </div>
</div>

${
  rejected.length > 0
    ? `<h2>Rejected by validation (${rejected.length})</h2><div class="card"><table><thead><tr><th>Check</th><th>Candidate</th><th>Reason</th></tr></thead><tbody>${rejected
        .map(
          (entry) =>
            `<tr><td>${escapeHtml(entry.check)}</td><td>${escapeHtml(entry.title)}</td><td>${escapeHtml(entry.reason)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : ""
}

<h2>Decision</h2>
<div class="card">
  <label for="comment">Comment (recorded in the audit trail)</label>
  <textarea id="comment"></textarea>
  <div class="actions">
    <button class="primary" id="approve" type="button">Approve selected</button>
    <button id="changes" type="button">Request changes</button>
    <button id="reject" type="button">Reject plan</button>
  </div>
  <div id="result"></div>
</div>

<script nonce="${nonce}">
(function(){
  var PLAN = ${JSON.stringify({ planId: plan?.id ?? "", planHash: run.planHash ?? "" })};
  var CSRF = ${JSON.stringify(csrfToken)};
  var POST = ${JSON.stringify(postPath)};
  var rows = Array.prototype.slice.call(document.querySelectorAll("tr[data-id]"));
  function boxes(){ return Array.prototype.slice.call(document.querySelectorAll("input[type=checkbox][data-case]")); }
  function applyFilters(){
    var f = {
      area: document.getElementById("f-area").value,
      persona: document.getElementById("f-persona").value,
      type: document.getElementById("f-type").value,
      priority: document.getElementById("f-priority").value,
      side: document.getElementById("f-side").value,
      source: document.getElementById("f-source").value
    };
    rows.forEach(function(row){
      var show = (!f.area || row.dataset.area === f.area)
        && (!f.persona || row.dataset.persona === f.persona)
        && (!f.type || row.dataset.type === f.type)
        && (!f.priority || row.dataset.priority === f.priority)
        && (!f.side || row.dataset.side === f.side)
        && (!f.source || row.dataset.source === f.source);
      row.classList.toggle("hidden", !show);
      var detail = document.querySelector('tr.detail[data-for="' + row.dataset.id + '"]');
      if (detail && !show) { detail.classList.add("hidden"); }
    });
  }
  ["f-area","f-persona","f-type","f-priority","f-side","f-source"].forEach(function(id){
    document.getElementById(id).addEventListener("change", applyFilters);
  });
  rows.forEach(function(row){
    row.addEventListener("click", function(event){
      if (event.target && event.target.tagName === "INPUT") { return; }
      var detail = document.querySelector('tr.detail[data-for="' + row.dataset.id + '"]');
      if (detail) { detail.classList.toggle("hidden"); }
    });
  });
  document.getElementById("select-all").addEventListener("click", function(){ boxes().forEach(function(b){ b.checked = true; }); });
  document.getElementById("clear").addEventListener("click", function(){ boxes().forEach(function(b){ b.checked = false; }); });
  document.getElementById("select-safe").addEventListener("click", function(){
    boxes().forEach(function(b){ b.checked = b.dataset.side === "none"; });
  });
  function submit(decision){
    var selected = boxes().filter(function(b){ return b.checked; }).map(function(b){ return b.dataset.case; });
    var excluded = boxes().filter(function(b){ return !b.checked; }).map(function(b){ return b.dataset.case; });
    fetch(POST, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nova-csrf": CSRF },
      body: JSON.stringify({
        planId: PLAN.planId, planHash: PLAN.planHash, decision: decision,
        selectedTestCaseIds: selected, excludedTestCaseIds: excluded,
        comment: document.getElementById("comment").value
      })
    }).then(function(r){ return r.json().then(function(j){ return { status: r.status, body: j }; }); })
      .then(function(res){
        var el = document.getElementById("result");
        if (res.status === 200) {
          el.textContent = "Recorded: " + decision + " (" + res.body.approvalId + "). Return to your terminal — Nova will not run anything until you ask it to.";
          Array.prototype.slice.call(document.querySelectorAll("button")).forEach(function(b){ b.disabled = true; });
        } else {
          el.textContent = "Rejected by Nova: " + (res.body.message || res.status);
        }
      })
      .catch(function(err){ document.getElementById("result").textContent = "Could not reach Nova: " + err; });
  }
  document.getElementById("approve").addEventListener("click", function(){ submit("approved"); });
  document.getElementById("changes").addEventListener("click", function(){ submit("changes_requested"); });
  document.getElementById("reject").addEventListener("click", function(){ submit("rejected"); });
})();
</script>
</body>
</html>`;
}

function renderRow(suggestion: SuggestedTestCase): string {
  const persona = suggestion.persona ?? "none";
  const mutates = suggestion.sideEffect !== "none";
  return `    <tr data-id="${escapeAttr(suggestion.id)}" data-area="${escapeAttr(suggestion.area)}" data-persona="${escapeAttr(persona)}" data-type="${escapeAttr(suggestion.testType)}" data-priority="${escapeAttr(suggestion.priority)}" data-side="${escapeAttr(suggestion.sideEffect)}" data-source="${escapeAttr(suggestion.source)}">
      <td><input type="checkbox" data-case="${escapeAttr(suggestion.id)}" data-side="${escapeAttr(suggestion.sideEffect)}"${mutates ? "" : " checked"}></td>
      <td>${escapeHtml(suggestion.id)}</td>
      <td>${escapeHtml(suggestion.area)}</td>
      <td>${escapeHtml(suggestion.journey)}</td>
      <td>${escapeHtml(persona)}</td>
      <td>${escapeHtml(suggestion.testCase.title)}</td>
      <td>${escapeHtml(suggestion.testType)}</td>
      <td>${escapeHtml(suggestion.priority)}</td>
      <td><span class="tag${mutates ? " mutates" : ""}">${escapeHtml(suggestion.sideEffect)}</span>${suggestion.requiredApprovalLevel === "elevated" ? ' <span class="tag elevated">elevated</span>' : ""}</td>
      <td>${escapeHtml(suggestion.source)}</td>
    </tr>
    <tr class="detail hidden" data-for="${escapeAttr(suggestion.id)}">
      <td colspan="10">
        <strong>Preconditions:</strong> ${escapeHtml(suggestion.testCase.preconditions.join(" · ") || "none")}<br>
        <strong>Steps:</strong> ${escapeHtml(
          suggestion.testCase.steps
            .map((step) => `${step.kind} ${step.url ?? step.selector ?? step.name ?? ""}`.trim())
            .join(" → "),
        )}<br>
        <strong>Expected result:</strong> ${escapeHtml(suggestion.expectedResult)}<br>
        <strong>Assertions:</strong> ${escapeHtml(
          suggestion.testCase.assertions
            .map((assertion) => `${assertion.kind}=${assertion.expected}`)
            .join(" · "),
        )}<br>
        <strong>Fixtures:</strong> ${escapeHtml(suggestion.fixtureRefs.join(", ") || "none")}<br>
        <strong>Evidence:</strong> ${escapeHtml(suggestion.evidenceRefs.join(", ") || "none")}<br>
        <strong>Rationale:</strong> ${escapeHtml(suggestion.rationale)}<br>
        <strong>Confidence:</strong> ${Math.round(suggestion.confidence * 100)}% &middot;
        <strong>Approval level:</strong> ${escapeHtml(suggestion.requiredApprovalLevel)}
      </td>
    </tr>`;
}

function authenticationLabel(run: TestRunState): string {
  switch (run.authenticationMode) {
    case "browser_session":
      return "Browser sign-in (session stored encrypted; no credential recorded)";
    case "saved_profile":
      return "Saved authentication profile";
    case "public_only":
      return "Public areas only (not signed in)";
    case "not_required":
      return "Not required";
    default:
      return "—";
  }
}

function uniqueOptions(values: string[]): string {
  return [...new Set(values)]
    .sort()
    .map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`)
    .join("");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
