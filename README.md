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
# writes report.json, junit.xml, and report.md, each finding linked to its
# screenshot/trace evidence
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

## Architecture

```
src/
  cli/         commander CLI: init, discover, plan, approve, run, report, mcp serve
  mcp/         MCP stdio server — thin wrappers around cli/commands.ts
  workflow/    the LangGraph StateGraph: nodes/, router.ts, graph.ts, state.ts,
               plan-templates.ts (deterministic planning), verify-classifier.ts
  domain/      Zod schemas for every persisted/graph-state shape (schemas/)
  services/
    browser/     Playwright discover + execute adapters
    persistence/ SqliteRunRepository — swap for Postgres by implementing
                 the same RunRepository interface, nothing else changes
    policy/      scope-policy.ts, secret-resolver.ts
    reporting/   JSON/JUnit/Markdown generators
  artifacts/   report-file writing
  config/      the one place environment variables are read
```

**LangGraph** (`@langchain/langgraph`) is the durable orchestration engine: a single `StateGraph` with `discover`, `plan`, `approval_gate`, `execute`, `verify`, `report` nodes, compiled with a real SQLite checkpointer (`@langchain/langgraph-checkpoint-sqlite`) for crash-resume durability within one `.invoke()` call. The CLI's separate commands (`discover`, then later `plan`, then later `approve`, then later `run`) are separate process invocations of the same compiled graph; cross-command continuity comes from `RunRepository` persisting the full `TestRunState` between them, and the graph's entry router (`routeFromStatus`) always resumes at the correct node from the persisted `status` field. `approval_gate`'s own outgoing edge always stops at `END` regardless of the decision — running an approved plan is a deliberately separate command (`nova run`), never an automatic side effect of approving it.

**LangChain** (`@langchain/core`, `@langchain/openai`) is present as a dependency for the next phase's model adapters, structured outputs, and optional knowledge retrieval — nothing in this MVP calls it. `plan` uses fixed templates (`workflow/plan-templates.ts`) derived directly from the discovery snapshot: one read-only smoke case per visited page, one state-changing case per discovered form.

**Zod** validates every schema in `domain/schemas/` — the same schemas are the graph's state contract, the SQLite persistence contract, and the MCP tool input/output contract; there is exactly one definition of what a `TestPlan` or `TestRunState` looks like.

## Tests

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

`tests/scope-policy.test.ts` and `tests/secret-resolver.test.ts` cover policy enforcement in isolation. `tests/graph.test.ts` drives the compiled LangGraph graph end to end with fake discover/execute dependencies (no real Playwright/network) to verify graph transitions: it stops after discover until an objective is supplied, stops at `awaiting_approval` until a decision is recorded, never auto-executes within the same invocation as approval, permanently stops a rejected run, and — for an approved run — executes only in-scope cases while a case declaring an out-of-manifest domain is blocked before it ever reaches Playwright.

## Extension points left explicit for a later phase

- Multi-agent collaboration, LangSmith tracing, cloud dependencies, and vector-database-backed knowledge retrieval are intentionally not present — `services/policy/secret-resolver.ts`'s `SecretResolver` interface and `services/persistence/run-repository.ts`'s `RunRepository` interface are the seams a later phase (real secrets manager, PostgreSQL, S3-compatible artifact storage) plugs into without touching the workflow layer.
- An LLM-backed planner would implement the same shape `workflow/plan-templates.ts`'s `generatePlanFromDiscovery` returns and be swapped in behind `createPlanNode()` — the graph, policy checks, and approval gate are unaffected by where a `TestPlan` came from.
- Team-server mode and signed packs are unimplemented; `RunRepository` and the MCP server are the two places a multi-tenant, network-exposed deployment would add authentication.
