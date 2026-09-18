# Authenticated scan design

## Problem

Discovery and execution only ever see anonymous, public routes. Any application
whose meaningful surface sits behind a login (dashboards, account settings,
admin views) is invisible to the harness today, and `README.md`'s safety
boundaries are explicit that neither phase may hold or use credentials.

## Goal

Let discovery and execution crawl and check authenticated routes without the
harness ever touching a username, password, MFA code, or SSO flow, and without
adding any new click/fill/submit/upload capability to the crawler. The harness
starts a browser session that is already logged in; it still cannot log in,
log out, or change anything.

## Non-goals

- Scripted login (filling a username/password form as part of a run). That
  reintroduces exactly the credential-handling surface this design avoids.
- Multi-account / role-based scanning in one run. One `storageStatePath` is one
  session; running as a second role means a second `login` capture and a
  second run.
- Detecting or refreshing an expired session automatically. A stale session
  degrades silently to whatever an anonymous visitor sees; the operator
  notices via discovery evidence and re-runs `login`.

## Approach: operator-captured Playwright storage state

Playwright's `BrowserContext.storageState()` serializes cookies and
`localStorage` to a JSON file. Handing that file to `browser.newContext({
storageState })` reproduces a logged-in session without the harness ever
seeing how the login happened — password, hardware key, SSO redirect, and MFA
are all opaque to it.

```text
nova login --url <app> --save-storage-state <path>   (operator, headed, manual)
                              │
                              ▼
                    <path>/storage-state.json  (cookies + localStorage only)
                              │
                              ▼
nova discover --url <app> --storage-state <path>      (harness, unattended)
```

`nova login`:

- Always headed (`headless: false`, not configurable) — a human is required.
- Opens the target URL, prints instructions, and blocks on Enter in the
  terminal while the operator authenticates however their application
  requires.
- On Enter, calls `context.storageState({ path })`, writes the file `0600`,
  and closes the browser. No credential ever crosses into harness state,
  SQLite, or model context — only a path string does.

`nova discover --storage-state <path>`:

- Validates the file exists at `start()` time (fail fast, not a silent
  degrade) and persists the path — never the content — on
  `HarnessRunInput.storageStatePath`.
- `PlaywrightAppDiscoverer` and `PlaywrightNavigationExecutor` pass
  `storageState: request.storageStatePath` into `browser.newContext(...)` when
  set; otherwise behavior is byte-for-byte unchanged from today.
- Execution reuses the same run's `storageStatePath` automatically — it is
  part of the persisted run input, not a separate flag on `execute`.

## What does not change

Every existing guarantee holds under authentication exactly as it does
unauthenticated:

- Discovery still never clicks, fills, submits, uploads, or evaluates
  credentials; it only reads whatever the pre-authenticated session already
  renders.
- Execution still only performs direct same-origin `GET` navigation and
  title/heading assertions against the approved snapshot.
- The origin allowlist, `maxPages`, destructive-path filtering, and
  HTTPS-by-default policy all apply unchanged; an authenticated session cannot
  reach further than the policy already permits.
- The app map, reports, and SQLite records store discovered content
  (redacted/truncated per existing rules) — never the storage-state file
  content, never a cookie value, never a header.

## Risks and mitigations

- **Storage-state file is a live session token.** Treated like a secret:
  written with `0600` permissions, referenced only by path in
  `HarnessRunInput`, never copied into `run_events`, the app map, or a
  generated report.
- **Stale/expired session.** No automatic detection in this design — the crawl
  simply sees whatever an anonymous visitor sees (typically a login page). The
  discovery warnings list and page titles/headings make this visible to a
  reviewer; automatic staleness detection is a follow-up, not required here.
- **Operator error (captures state before completing MFA).** `login` blocks on
  an explicit Enter press specifically so the operator controls when the
  snapshot is taken.

## Schema changes

- `HarnessRunInputSchema` gains `storageStatePath: z.string().min(1).optional()`.
- `DiscoveryRequest` and `NavigationExecutionInput` both gain the same optional
  field, threaded from `HarnessWorkflow`'s `discover`/`execute` steps.

No new run status, no new approval type: an authenticated run flows through
the identical Discover → Plan → Approve → Execute graph as an anonymous one.
