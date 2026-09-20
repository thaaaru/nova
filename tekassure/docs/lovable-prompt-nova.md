# Lovable prompt — Nova dashboard design

Paste the prompt below into Lovable for visual/UX exploration only. Treat its
output as a design reference (look and feel, layout, states) — the real
dashboard is server-rendered HTML in `src/serve/dashboard-html.ts` with no
frontend framework, and stays that way; Lovable's generated code is not
integrated directly.

---

```
Design a web dashboard for "Nova" — a governed, read-only AI-assisted
web app testing tool. It discovers routes in a web application, proposes a
test plan, waits for a human to approve it, then runs constrained read-only
checks (page loads + assertions only — it never clicks, fills, submits, or
uploads anything). Visual tone: engineering/ops tool, not consumer product —
think Linear, Vercel, or GitHub Actions. Clean, dense, monospace accents for
IDs/URLs, calm neutral palette with a single accent color, generous
whitespace, small badges for status.

Information architecture (three levels, breadcrumb nav at all times):
Projects → Apps → Scans.

Screens:

1. Projects list — card or table grid of projects (name, app count, most
   recent scan status, last activity). Empty state: "Create your first
   project." Primary action: "New project" (name only).

2. Project detail — breadcrumb "Projects / {name}". List of Apps within
   this project as cards: app name, base URL, small status chip
   (last scan: passed/failed/pending), scan count, last scanned time.
   Primary action: "Add app" (name + base URL). Secondary: link to capture
   an authenticated login session for this app.

3. App detail — breadcrumb "Projects / {name} / {app name}". Table of Scans,
   newest first: "Scan #12", status badge (discovering / awaiting approval /
   ready to execute / executing / passed / failed / rejected), whether it
   used an authenticated session (small lock icon vs. globe icon), started
   time, duration. Primary action: "Start new scan" — a form/drawer with:
   target URL (prefilled from app), goal/objective (optional text, default
   "web-app-baseline"), max pages to inspect (number), allow-insecure-http
   toggle, and a dropdown to pick a previously captured login session
   (or "none — anonymous").

4. Scan detail — breadcrumb "Projects / {name} / {app name} / Scan #12".
   This is a status-driven workflow view, not a static page — design each
   state distinctly:
   a. Discovering/Planning (transient) — spinner/skeleton, "Discovering
      routes…"
   b. Awaiting approval — shows the discovered pages (list with
      screenshots thumbnails, title, detected controls) and the proposed
      test plan (list of planned checks per page, each tagged
      read-only/session-change/state-change). Two buttons: Approve
      (name field) / Reject (name + optional note).
   c. Ready to execute — big "Execute now" button. Once clicked, show a
      live checklist that streams in: each page being checked, then
      passed/failed with a checkmark/cross, in real time (like a CI job
      log).
   d. Passed/Failed (terminal) — summary banner (N of M checks passed),
      full results table (URL, status, error if any, screenshot
      thumbnail), buttons: "View full report" / "Download PDF".
   e. Rejected — simple message, who rejected it and why, no results.
   f. Failed-but-retryable — same as (c) but the button says "Retry
      execution".

5. Login capture flow — a modal or dedicated page: "Capture a login
   session" — explain that Nova never sees credentials, a separate
   real browser window opens for the person to log in by hand (password,
   MFA, SSO — whatever the app needs), then they come back and click
   "I'm logged in — save this session." List of previously captured
   sessions per app (label, captured date, "re-capture" action for when a
   session expires).

Global elements: persistent left sidebar for Projects/Apps navigation,
top-right shows current dashboard user/org, a subtle banner or footer note
reinforcing "Read-only: no clicks, form fills, or submissions are ever
performed" so the safety model is visible, not just documented.

Responsive down to tablet width is enough — this is an internal ops tool,
not consumer mobile.
```

</content>
