# Nova

Nova is a governed AI orchestration runtime for web application test automation. It is installed and run by a test engineer; an IDE/CLI AI agent connects to it over MCP as an **operator interface only** — Nova itself is the authoritative boundary for policy, scope, approval, execution, evidence, and reporting. The model may discover, plan, explain, and classify; it never decides authorization, never sees a raw secret, and never bypasses a policy check written in code.

```
discover → plan → approval gate → execute → verify → report
```

This MVP is deterministic end to end: **no LLM call is required or made anywhere in this codebase yet.** Planning uses fixed templates derived from what discover actually found. LangChain/LangGraph's model-adapter surface is wired in architecturally (see [Architecture](#architecture)) for a later phase, but nothing in this release calls a model.

## Install

Requires Node.js 22+ (pnpm is bootstrapped automatically via corepack if missing).

```bash
git clone https://github.com/thaaaru/nova.git && cd nova && ./install.sh
```

Run commands either via the built CLI (`node dist/cli/index.js ...`) or directly against source with `pnpm nova ...` (uses `tsx`, no build step needed while iterating).

## Local run

```bash
pnpm nova init
# edit nova.manifest.json: set allowedDomains to your target's real domain(s)

pnpm nova discover --target https://staging.example.test/ --manifest nova.manifest.json
# -> Run <runId>: discovered N page(s).

pnpm nova plan --objective "Test the checkout flow for a registered customer." --run <runId>
# -> lists every generated case, its risk level, and execution mode

pnpm nova approve --plan <runId> --reviewer "you@example.test"
# nothing can execute before this; --reject records a rejection instead

pnpm nova run --plan <runId>
# executes only the approved cases; each state-changing case is re-checked
# against policy immediately before it runs, not just at approval time

pnpm nova report --run <runId>
# writes report.json, junit.xml, report.md, and a self-contained,
# offline report.html (no external CSS/JS/fonts), each finding linked
# to its screenshot/trace evidence
```

`--run`/`--plan` are optional after `discover` — Nova remembers the most recently discovered run as a convenience "current run" pointer, always overridable by passing the id explicitly. Plan and run identifiers are the same id in this MVP (one plan per run).

### Example: the checkout objective from the spec

`fixtures/demo-app/` is a tiny static three-page app (home → sign in → checkout) and `fixtures/sample-plan.json` is a hand-written, schema-valid `TestPlan` against it, showing what a real plan (including a secret-referenced password field) looks like:

```bash
python3 -m http.server 4173 --directory fixtures/demo-app &
pnpm nova discover --target http://localhost:4173/ --manifest fixtures/sample-manifest.json
pnpm nova plan --objective "Test the checkout flow for a registered customer." --run <runId>
pnpm nova approve --plan <runId> --reviewer demo
NOVA_SECRET_STANDARD_USER_PASSWORD=correct-horse-battery-staple pnpm nova run --plan <runId>
pnpm nova report --run <runId>
```

## Application Test Map

The Application Test Map is Nova's QA-facing product surface: a durable, versioned catalogue of an application's functional areas, user journeys, personas, test-data fixtures, and approved scope — the thing a QA engineer actually thinks in terms of, instead of manifests, plans, and graph state. Everything below it (discover → plan → approval gate → execute → verify → report) is unchanged; the map is a curated, reusable _source_ for that pipeline, not a replacement for it.

```
ApplicationTestMap
├─ approvedScope        allowedDomains/allowedApiHosts/allowedMethods/executionMode
├─ areas[]               risk level + journeys[]
│   └─ journeys[]        mode (quick_test | guided_test | controlled_test), checkpoints[],
│                        requiredPersonaIds/requiredFixtureIds, status (draft|approved|deprecated)
├─ personas[]            credentialReferenceId only — never a raw credential
├─ fixtures[]            dataReferenceId only, optional lockRequired + cleanupAction
└─ knownConstraints[]    informational; never itself a policy gate
```

No raw credential, token, PII, or payment value is ever stored in a map — `credentialReferenceId`/`dataReferenceId` are opaque pointers resolved the same way `secret:<id>` already is (`services/policy/secret-resolver.ts`).

### Setup and discovery workflow

```bash
pnpm nova map discover --target https://staging.example.test/ --name "My App" --env staging
# -> a *draft* map: deterministic heuristics only (URL path segment -> area,
#    one smoke journey per page, one journey per discovered form) — never a
#    model call. approvedScope.executionMode starts at "observe" until a
#    QA engineer reviews it.

pnpm nova map show <map-id>              # inspect the full area/journey tree
pnpm nova journey approve <journey-id> --map <map-id>   # curate: draft -> approved
```

A journey only ever runs once its own `status` is `"approved"` — curation is a deliberate, auditable step, not a side effect of discovery. Try the whole thing without a live target using the checked-in seed map:

```bash
./scripts/demo-application-test-map.sh
```

This seeds `fixtures/sample-application-test-map.ts` (a realistic fictional e-commerce map: 6 areas, 14 journeys — including `registered_customer_checkout`/`guest_checkout`/`invalid_payment_handling`/`coupon_discount_calculation`/`order_confirmation` under checkout — 3 personas, 5 fixtures) into a scratch database and walks through listing areas/journeys, recommendations, natural-language matching, a `quick_test` run, and a `controlled_test` run through its approval gate, end to end.

### Execution modes

A journey's `mode` is a property of its own curated definition (set once by whoever approves it), not a per-run choice:

| Mode              | Behavior                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quick_test`      | Pre-approved, known scope and data. `nova journey run` executes immediately — no extra step.                                                                                                                                                                  |
| `guided_test`     | Stages the run and shows the generated plan; a single explicit `nova journey confirm <run-id> --reviewer <name>` (or the TUI's "Review plan" → "Run") starts execution.                                                                                       |
| `controlled_test` | Stages the run exactly like `guided_test`, but the product intent is a _separate_ reviewer confirming it — the TUI shows "Submit for approval" instead of a one-keypress run, and `nova journey confirm` is the same explicit, auditable approval either way. |

Every mode funnels through the exact same `awaiting_approval → approval_gate → execute` path the plain `nova plan`/`nova approve`/`nova run` CLI already uses (`services/testmap/journey-run-service.ts` calls `runApprove`/`runExecution` from `cli/commands.ts` verbatim) — a journey run is never a weaker, parallel execution path.

### CLI reference

```bash
nova map discover --target <url> --name <applicationName> --env <local|development|staging|production>
nova map list
nova map show <map-id>
nova area list --map <map-id>
nova journey list --map <map-id> [--area <area-id>]
nova journey approve [journey-id] --map <map-id>
nova journey run [journey-id] --map <map-id> --env <environment> [--persona <id>] [--fixture <id>...]
nova journey confirm <run-id> [--reviewer <name>]     # required for guided_test/controlled_test
nova journey describe <map-id> "<free text>"          # natural-language test creation, see below
nova recommendations --map <map-id>
nova report [--run <run-id>]
```

`map discover`, `journey run`, `journey approve`, and `report` all resolve their inputs through one shared layer (`cli/interactive/resolve-inputs.ts`): every flag above is optional, and any input missing on a real interactive terminal opens a short guided prompt for exactly the missing values (sensible defaults are derived and pre-filled — an application name from the target's hostname, an environment guess from the hostname, an approved journey/most-recently-updated map when there's an obvious one — but every derived _guess_ still requires an explicit confirmation, never a silent one) ending in a plain-language summary and a `Yes`/`Cancel` gate. Supplying every value on the command line runs with zero prompts, exactly as before. `--interactive` forces that same guided review even when nothing is missing; `--non-interactive` (and CI, and any non-TTY invocation, automatically and unconditionally) never prompts — a still-missing input instead fails once, up front, listing every missing flag together with a worked example, rather than the old one-flag-at-a-time Commander error. None of this changes what gets validated or executed: the same `map-service.ts`/`cli/commands.ts` functions, the same Zod schemas, and the same approval/scope/fixture-lock enforcement run either way — guided input only decides how a value reaches that layer, never what happens once it's there.

Every one of these is a thin wrapper around `services/testmap/map-service.ts` — the exact same functions the TUI calls, so there is no separate, weaker CLI-only or TUI-only path through scope/approval/fixture-locking.

### Natural-language test creation

`nova journey describe <map-id> "Test coupon handling when a registered customer checks out"` (or the TUI's "Describe a test") never fabricates a brand-new automated script from free text. `services/testmap/nl-match-service.ts` scores the request against every existing journey's own name/description/area (deterministic keyword overlap, never an LLM call); a close match is reused as-is — its real checkpoints, personas, fixtures, and locators, untouched — and anything below threshold instead produces an unapproved `guided_test` draft journey with a single placeholder checkpoint, which a QA engineer must curate with real steps before it can ever be approved to run.

### Regression recommendations

`nova recommendations --map <map-id>` (deterministic-only for now — `services/testmap/recommendation-service.ts`'s `RegressionSignalSource` interface is the explicit seam for a later Git/PR change-impact analyzer) ranks approved journeys by risk level, then surfaces a journey if its last run failed, was flaky, was blocked by policy, or hasn't run within a configurable staleness window (default 14 days):

```
1. Invalid payment handling — High risk — Last run failed
2. Update cart item quantity — Medium risk — Recently flaky
3. Browse product catalogue — Low risk — Not run in 60 days
```

### Fixture locks and cleanup

A fixture with `lockRequired: true` (e.g. a shared coupon code or sandbox payment card) can only be held by one run at a time — `ApplicationTestMapRepository.acquireFixtureLock`/`releaseFixtureLock` enforce this in SQLite, and a run either acquires every fixture it needs or none of them. The lock is always released, and any declared `cleanupAction` is recorded as a `fixture_cleanup_recorded` audit event, in a `finally` block that runs even when the journey fails — Nova has no arbitrary-code-execution path, so a cleanup action is recorded as performed, never shelled out to.

## Terminal UI

```bash
pnpm nova tui
```

The Home screen is application-centred, not graph-centred:

```
NOVA — Shop Staging / staging

1. Test an application area
2. Describe a test
3. Run recommended regression tests
4. Explore and update application map
5. Review failures and recoveries
6. Open recent reports
7. Advanced command mode
```

Option 1 is the primary path: select area → select journey → select environment/persona/fixture (only combinations valid for that journey and the map's approved scope are offered) → a concise pre-run summary (goal, checkpoints, policy, recovery budget) → run → live progress with recovery cards → the offline HTML report. Ordinary safe journeys never force an engineer through separate discovery/planning/approval screens — those stages still run internally (`services/testmap/journey-run-service.ts` builds the plan and, for `guided_test`/`controlled_test`, genuinely stops for the confirmation step described above; it is never skipped, only presented as one flow). A recovery card is rendered in QA language, never as raw internals:

```
Checkout action could not be completed.

Observed:
The expected payment control is no longer available.

Nova proposes:
Rediscover approved checkout controls and resume from
"Shipping details submitted".

Recovery:
Attempt 1 of 2
```

Raw locator strategies/selectors are hidden at standard verbosity and only surface at `diagnostic` verbosity — never as a model prompt or graph-internal detail, because there is no model in this path at all. Options 2–7 map directly to natural-language test creation, regression recommendations, map curation (approving a draft journey), a failures/recovery review list, the report/artifact opener, and (option 7) the same command palette described below — every one of them calls `services/testmap/map-service.ts` or the plain `src/cli/commands.ts` functions, never a reimplementation.

A calm, dark, keyboard-driven interface (Ink + React) built on the identical service functions the CLI and MCP server use — the TUI never reimplements discovery, planning, approval, execution, recommendation, or matching logic. Press `:` for a command palette (`:discover`, `:plan`, `:approve`, `:run`, `:report`, `:verbosity`, `:animation off`, …), `V` to change verbosity (executive/standard/diagnostic) without restarting, `Q` to quit.

## MCP integration

```bash
pnpm nova mcp serve
```

Starts Nova's MCP server over stdio, exposing `nova_discover`, `nova_plan`, `nova_approve`, `nova_run`, and `nova_report` as tools — thin wrappers around the exact same functions the CLI calls, so there is no separate, weaker "MCP path" through policy or approval. Point your MCP-capable IDE/CLI agent at it, e.g. in a Claude Desktop-style config:

```json
{
  "mcpServers": {
    "nova": {
      "command": "node",
      "args": ["/absolute/path/to/nova/dist/cli/index.js", "mcp", "serve"],
      "env": { "NOVA_DATABASE_PATH": "/absolute/path/to/data/nova.sqlite" }
    }
  }
}
```

The agent can call `nova_discover`/`nova_plan` freely to help an engineer iterate, but `nova_approve`'s decision and `nova_run`'s execution still go through every policy check `checkExecutionAllowed`/`checkCaseScope` enforce in code — an agent cannot grant itself execution authority by calling tools in a particular order.

## Docker

```bash
docker compose build
docker compose run --rm nova init
docker compose run --rm nova discover --target https://staging.example.test/ --manifest fixtures/sample-manifest.json
# ...plan / approve / run / report the same way, each via `docker compose run --rm nova <command>`
docker compose up nova   # long-running `mcp serve` over stdio, if you want the container as the MCP endpoint
```

`data/` and `artifacts/` are named volumes — durable state and evidence survive a container recreate.

## Security constraints enforced in code

- **Scope is a manifest, not a suggestion.** `services/policy/scope-policy.ts`'s `isDomainAllowed`/`checkRuntimeUrl`/`checkCaseScope` are plain string comparisons against `TargetManifest.allowedDomains` — never inferred from model output. `execute`'s Playwright route handler aborts any navigation to a domain outside the manifest, live, in addition to the plan-time check.
- **No execution before approval, checked twice.** `approval_gate` records the human decision; `checkExecutionAllowed` re-checks it immediately before every single case runs inside `execute`, independent of the graph's own status field — a bug elsewhere in the state machine can't let an unapproved or rejected case slip through.
- **Secrets are opaque IDs, never values, in graph state.** A step's `value` can be `secret:<id>`; `services/policy/secret-resolver.ts` resolves it from `NOVA_SECRET_<ID>` at the last possible moment inside the browser executor. The resolved value is never written back into `TestRunState`, so it never reaches a report, an audit event, or (in a later phase) a prompt.
- **Verification is deterministic-first.** `workflow/verify-classifier.ts` classifies every case from its recorded assertion/step evidence alone; a defect candidate is only ever created when a step failed or an assertion mismatched, and a harness limitation (an assertion kind the MVP can't yet evaluate) is reported as `inconclusive`, never as a false defect against the app under test.
- **Every state transition and policy decision is audited.** Every node appends to `TestRunState.auditEvents` (who/what/when), independent of and never overwritten by anything a model produced.
- **No arbitrary shell commands anywhere in the execution path.**
- **Recovery is bounded, deterministic, and never a policy decision.** `services/recovery/recovery-agent.ts` retries a failed step with a fixed, ordered set of alternate _semantic_ locators (role+name, visible text, label) on the same page only — never a different page, domain, or action, never touching secrets or approval, and never an LLM call. It stops after the case's own `recoveryBudget` (0–3, code-reviewed at plan-approval time) and reports exhaustion as a real failure rather than silently retrying forever.
- **A run-level execution-mode ceiling limits what a plan can even contain.** `TargetManifest.runExecutionMode` (`observe`/`safe_test`/`destructive_test`) is enforced in `checkExecutionAllowed`: `observe` mode rejects every state-changing case outright, even an approved one, and `plan-templates.ts` never generates one in the first place under `observe`.
- **A journey run can never widen scope beyond what the Application Test Map already approved.** `services/testmap/map-to-plan.ts`'s `buildManifestFromMap` derives the `TargetManifest` straight from `ApplicationTestMap.approvedScope` — a journey/persona/fixture combination is validated against the map (`journey-run-service.ts`'s `validateJourneyRunContext`) before a single row is written, and every generated case is still re-checked by the same `checkExecutionAllowed`/`checkCaseScope` as the plain CLI path.
- **A journey only runs once curated and approved.** `UserJourney.status` (`draft`/`approved`/`deprecated`) gates whether a journey is runnable at all, independent of and prior to any per-run approval its `mode` requires — an AI-drafted candidate journey from discovery can never execute until a QA engineer explicitly approves it.
- **Fixture locks are all-or-nothing and always released.** A run acquires every `lockRequired` fixture it needs or none of them; release plus any declared cleanup-audit recording happens in a `finally` block, so a crashed or failed run never leaves a fixture stuck locked.

## Architecture

```
src/
  cli/         commander CLI: init, discover, plan, approve, run, report, mcp serve, tui
  mcp/         MCP stdio server — thin wrappers around cli/commands.ts
  tui/         Ink + React terminal UI: app.tsx, screens/, components/, hooks/,
               command-mode/, theme/, services/ (view-model + verbosity mapping) —
               calls cli/commands.ts's functions exclusively, no duplicated logic
  workflow/    the LangGraph StateGraph: nodes/, router.ts, graph.ts, state.ts,
               plan-templates.ts (deterministic planning), verify-classifier.ts
  domain/      Zod schemas for every persisted/graph-state shape (schemas/),
               including tui.ts (TUI view models), reporting.ts (ReportData),
               and test-map.ts (ApplicationTestMap/UserJourney/Checkpoint/
               TestPersona/TestDataFixture/ApprovedScope/KnownConstraint)
  services/
    browser/     Playwright discover + execute adapters
    recovery/    bounded, deterministic locator-recovery agent (no LLM)
    testmap/     Application Test Map product layer: map-service.ts (the one
                 CLI/TUI entrypoint), map-to-plan.ts (journey -> TestPlan,
                 deterministic), journey-run-service.ts (mode routing, scope
                 validation, fixture locks/cleanup — reuses cli/commands.ts's
                 runApprove/runExecution verbatim), discovery-to-map.ts,
                 recommendation-service.ts, nl-match-service.ts
    persistence/ SqliteRunRepository, SqliteApplicationTestMapRepository —
                 swap for Postgres by implementing the same interfaces,
                 nothing else changes
    policy/      scope-policy.ts, secret-resolver.ts
    reporting/   JSON/JUnit/Markdown generators, report-data-adapter.ts
                 (TestRunState -> ReportData), html-report-generator.ts,
                 chart-renderer.ts (self-contained inline-SVG charts)
  artifacts/   report-file writing
  config/      the one place environment variables are read
```

**LangGraph** (`@langchain/langgraph`) is the durable orchestration engine: a single `StateGraph` with `discover`, `plan`, `approval_gate`, `execute`, `verify`, `report` nodes, compiled with a real SQLite checkpointer (`@langchain/langgraph-checkpoint-sqlite`) for crash-resume durability within one `.invoke()` call. The CLI's separate commands (`discover`, then later `plan`, then later `approve`, then later `run`) are separate process invocations of the same compiled graph; cross-command continuity comes from `RunRepository` persisting the full `TestRunState` between them, and the graph's entry router (`routeFromStatus`) always resumes at the correct node from the persisted `status` field. `approval_gate`'s own outgoing edge always stops at `END` regardless of the decision — running an approved plan is a deliberately separate command (`nova run`), never an automatic side effect of approving it.

**LangChain** (`@langchain/core`, `@langchain/openai`) backs the orchestrator's one LLM integration point: `plan` always computes the deterministic template first (`workflow/plan-templates.ts`, one read-only smoke case per visited page, one state-changing case per discovered form), then — only when `DEEPSEEK_API_KEY` is set — asks DeepSeek (via `@langchain/openai`'s `ChatOpenAI` pointed at DeepSeek's OpenAI-compatible endpoint, `services/llm/deepseek-plan-generator.ts`) to propose cases instead. Every proposed case is re-validated against `checkCaseScope` before it can reach approval, and `allowedDomains` is stamped by code, never accepted from the model; any case that fails scope, or a model call that throws, falls back to the template plan, so the plan is never empty and a missing/invalid key never breaks `nova plan`. No LLM calls exist anywhere else in the pipeline — discover, recovery, and natural-language journey matching stay fully deterministic.

**Zod** validates every schema in `domain/schemas/` — the same schemas are the graph's state contract, the SQLite persistence contract, and the MCP tool input/output contract; there is exactly one definition of what a `TestPlan` or `TestRunState` looks like.

## Tests

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

`tests/scope-policy.test.ts` and `tests/secret-resolver.test.ts` cover policy enforcement in isolation, including the `observe`-mode execution ceiling. `tests/recovery-agent.test.ts` drives the recovery agent against a real (headless) Playwright page — budget-zero no-op, a genuine role+name recovery, exhaustion, and refusal to "recover" an ambiguous match. `tests/graph.test.ts` drives the compiled LangGraph graph end to end with fake discover/execute dependencies (no real Playwright/network) to verify graph transitions: it stops after discover until an objective is supplied, stops at `awaiting_approval` until a decision is recorded, never auto-executes within the same invocation as approval, permanently stops a rejected run, and — for an approved run — executes only in-scope cases while a case declaring an out-of-manifest domain is blocked before it ever reaches Playwright. `tests/report-data-adapter.test.ts`, `tests/chart-renderer.test.ts`, and `tests/html-report-generator.test.ts` cover the HTML report pipeline (executive-summary derivation, timeline skip/complete detection, findings, recovery-funnel counts, audit redaction, SVG chart structure, and section-by-section HTML content including correct green/red color restriction). `tests/tui/*` cover the TUI's view-model mapping, command parsing/validation, verbosity filtering, and a rendered-frame assertion on the Home screen at both wide and narrow terminal widths.

`tests/test-map-schemas.test.ts` validates every new Zod schema (valid construction plus a deliberately invalid case per schema). `tests/journey-run-service.test.ts` covers scope enforcement (`validateJourneyRunContext` rejecting a wrong environment, a persona not permitted in it, a missing/unknown fixture, an unapproved journey), quick/guided/controlled mode routing (quick_test executes with no extra call; guided_test/controlled_test stay `awaiting_approval` until a separate `confirmJourneyRun`), and fixture-lock/cleanup behavior (locked even under a failing run, always released, `fixture_cleanup_recorded` always audited). `tests/test-map-repository.test.ts` covers the SQLite-backed lock semantics directly. `tests/nl-match-service.test.ts` and `tests/recommendation-service.test.ts` cover natural-language journey matching (a close match reuses the real journey; an unrelated request produces a draft) and deterministic regression ranking (failed/flaky/stale journeys recommended, a recently-passed journey is not, higher risk sorts first) against the seeded e-commerce fixture. `./scripts/demo-application-test-map.sh` is the checked-in, runnable end-to-end demo.

`tests/discover-input-rules.test.ts` covers target-URL normalization/validation (rejecting Markdown link syntax and non-http(s) URLs, stripping a bare trailing slash), hostname-derived application-name/environment defaults. `tests/interactivity.test.ts` covers every `--interactive`/`--non-interactive`/CI/non-TTY precedence rule. `tests/resolve-inputs.test.ts` and `tests/guided-command-fields.test.ts` drive the shared guided-input resolver end to end with a scripted stand-in terminal (no real TTY): zero prompts when every input is already valid, prompting only for the missing fields with derived defaults pre-filled, re-prompting on an invalid/Markdown URL, cancelling cleanly (explicit "Cancel" and stream-closed/Ctrl+C) with no stack trace, `--interactive` re-reviewing an already-complete input set, and non-interactive mode reporting every missing flag in one error instead of guessing — applied against all four guided commands (`map discover`, `journey run`, `journey approve`, `report`), including their runtime-dependent choices (only approved journeys offered to run, only draft journeys offered for approval, the most recently updated map defaulted, a journey's own map environment silently trusted since it is a fact and not a guess).

## Extension points left explicit for a later phase

- Multi-agent collaboration, LangSmith tracing, cloud dependencies, and vector-database-backed knowledge retrieval are intentionally not present — `services/policy/secret-resolver.ts`'s `SecretResolver` interface and `services/persistence/run-repository.ts`'s `RunRepository` interface are the seams a later phase (real secrets manager, PostgreSQL, S3-compatible artifact storage) plugs into without touching the workflow layer.
- Team-server mode and signed packs are unimplemented; `RunRepository` and the MCP server are the two places a multi-tenant, network-exposed deployment would add authentication.
- Git/PR change-impact analysis for regression recommendations is not implemented — `services/testmap/recommendation-service.ts`'s `RegressionSignalSource` interface (`additionalReasons(map): Promise<Map<journeyId, reason>>`) is the seam a later phase plugs a real diff/blame-based analyzer into, without changing how recommendations are ranked or presented.
