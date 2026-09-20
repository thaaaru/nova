# Requirements-to-test-case generation design

## Context

The artifact store makes approved, project-scoped Markdown requirements available
to Nova. Discovery and the current `HeuristicTestPlanner` remain useful,
but they only describe evidence from the presently rendered application. This
design adds a top-down planning stage that derives _proposed_ test cases from
requirements artifacts, then maps them to discovery evidence without granting
any additional browser, repository, network, or credential access.

The output remains reviewable before execution. It must never turn an
ambiguous requirement into an executable state-changing action automatically.

## Goals

- Generate deterministic, schema-validated test-case candidates from selected
  project artifacts.
- Preserve traceability from every generated test case to artifact and source
  location evidence.
- Map each candidate to the discovery snapshot for a run and report coverage
  gaps without treating a missing observed route as a product failure.
- Store the approved generation result as a `generated-test-plan` Markdown
  artifact, using the existing disk-plus-SQLite artifact store.
- Keep the existing `discover`, approval, and constrained read-only `execute`
  behavior intact.

## Non-goals

- Executing generated cases, interacting with a live application, or changing
  the current executor's read-only guarantees.
- Reading a source repository or requiring repository credentials.
- Fetching artifact content from URLs, parsing PDF/DOCX/binary files, or
  storing Markdown content in SQLite.
- Replacing the existing deterministic `HeuristicTestPlanner` in this
  milestone.
- Building a vector database, retrieval service, embeddings pipeline, or a
  general-purpose agent framework. Project artifact selection is explicit and
  bounded for this first version.

## Architecture

Use a modular-monolith extension. The generation service receives only the
project's selected Markdown artifact files and, optionally, one persisted
`AppSnapshot`. It produces a structured candidate plan, validates it, writes a
versioned generated-plan artifact, and returns JSON to the CLI.

```text
operator
  | nova generate --project <id> [--run <runId>]
  v
CLI command
  | validates license, project, artifact files, and optional run ownership
  v
RequirementsPlanGenerator
  | selected Markdown + optional AppSnapshot
  v
schema-validated RequirementsTestPlan
  |-- source references --> existing project artifacts
  |-- coverage mapping --> persisted discovery snapshot
  v
ProjectRepository + filesystem
  | SQLite metadata       | projects/<project>/artifacts/<id>-generated-test-plan.md
  v
reviewer
```

The generator has no Playwright instance, no filesystem access outside the
explicit artifact paths supplied by the CLI, no environment-secret access, and
no source-code or repository adapter.

## Domain model

Add the following schemas to `src/domain.ts` in the implementation milestone.
The IDs are UUIDs and all timestamps are ISO datetimes, following the existing
domain convention.

```ts
export const RequirementSourceSchema = z.object({
  artifactId: z.string().uuid(),
  filePath: z.string(),
  section: z.string().trim().min(1).max(500),
  excerpt: z.string().trim().min(1).max(2_000),
});

export const RequirementCoverageSchema = z.object({
  status: z.enum(["mapped", "partial", "unmapped", "not-applicable"]),
  discoveredPaths: z.array(z.string()),
  rationale: z.string().trim().min(1).max(2_000),
});

export const GeneratedTestCaseSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(2_000),
  preconditions: z.array(z.string().trim().min(1).max(500)),
  steps: z.array(z.string().trim().min(1).max(2_000)).min(1),
  expectedResult: z.string().trim().min(1).max(2_000),
  risk: RiskLevelSchema,
  requiresApproval: z.boolean(),
  sources: z.array(RequirementSourceSchema).min(1),
  coverage: RequirementCoverageSchema,
});

export const RequirementsTestPlanSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
  artifactIds: z.array(z.string().uuid()).min(1),
  summary: z.string().trim().min(1).max(4_000),
  cases: z.array(GeneratedTestCaseSchema).min(1),
  gaps: z.array(z.string().trim().min(1).max(2_000)),
  warnings: z.array(z.string().trim().min(1).max(2_000)),
});
```

`RequirementSource` is the mandatory audit link: `section` is a human-readable
heading or line range, and `excerpt` is bounded evidence copied verbatim from
the source Markdown. A model must not produce a case without at least one
source reference. `RequirementCoverage` describes correlation with discovery;
it is not a verdict that the product has a defect.

A case that proposes authentication, mutation, upload, deletion, payment, or
any other state-changing behavior must use `risk: "state_change"` and
`requiresApproval: true`. The generator defaults ambiguous cases to that safe
classification. It does not emit Playwright code or secret references.

## Inputs and validation

### Artifact selection

`generate` selects only artifacts belonging to the supplied project and whose
type is one of `requirements`, `test-spec`, `use-case`, or `api-spec`. By
default it selects all of those types. `--artifact <artifactId...>` narrows the
selection; every requested artifact must exist and belong to the project.

Before generation, the application must:

1. Look up the project; fail closed with `Project not found: <id>`.
2. Look up each selected artifact in SQLite and confirm its `projectId`.
3. Resolve each stored path under `projects/<projectId>/artifacts`; reject
   missing files and paths that escape that directory.
4. Read plain UTF-8 Markdown only; reject an empty selection or empty source
   document with a clear error.

The Markdown frontmatter is metadata, not an instruction channel. The
frontmatter and body are treated as untrusted document content and cannot
change tool policy, artifact selection, or approval requirements.

### Optional discovery mapping

`--run <runId>` requests mapping to that run's saved snapshot. The run must
exist, its `input.projectId` must exactly equal `--project`, and it must have a
snapshot. Otherwise generation fails closed with a clear error. No `--run`
means the plan has no `runId`; cases use `coverage.status: "not-applicable"`
and the plan warns that no live discovery evidence was supplied.

## Generator contract

Introduce a narrow interface beside the current planner:

```ts
export type RequirementsPlanRequest = {
  project: Project;
  artifacts: Array<{ artifact: Artifact; markdown: string }>;
  snapshot?: AppSnapshot;
};

export interface RequirementsPlanGenerator {
  generate(request: RequirementsPlanRequest): Promise<RequirementsTestPlan>;
}
```

The first implementation may use an LLM provider only through an injected
adapter. The adapter receives a fixed system instruction, selected artifact
text, and optional structured snapshot; it receives no ambient filesystem,
network, browser, shell, or credential tool. Its response is parsed with
`RequirementsTestPlanSchema`. Invalid output is rejected, not repaired into a
plausible plan. Provider choice, prompts, evaluations, and model credentials
are configuration concerns of a follow-up implementation spec.

A deterministic fake implementation must be injectable for tests.

## Generation workflow

```yaml
workflow: requirements_test_case_generation
trigger: nova generate --project <projectId> [--run <runId>]
risk_class: R2

states:
  - name: validate_input
    transitions:
      - on: valid → load_artifacts
      - on: invalid → failed

  - name: load_artifacts
    transitions:
      - on: loaded → generate_candidates
      - on: file_missing_or_escaped → failed

  - name: generate_candidates
    retry_budget: 0
    transitions:
      - on: schema_valid → map_discovery
      - on: provider_or_schema_failure → failed

  - name: map_discovery
    transitions:
      - on: mapped → persist_generated_artifact

  - name: persist_generated_artifact
    transitions:
      - on: persisted → ready_for_review
      - on: write_failure → failed

  - name: ready_for_review
    type: terminal
```

The generated plan is **not** a `HarnessWorkflow` execution plan and does not
transition a run to `awaiting_approval` or `ready_to_execute`. It is an
artifact for human review. A later design may define explicit conversion of
reviewed cases into an executable `TestPlan`; that conversion must retain
source traceability and pass the existing approval gate.

Persistence is ordered as follows: validate output, render Markdown in memory,
write the generated artifact file atomically (temporary sibling then rename),
then insert its metadata using `ProjectRepository.createArtifact`. If database
insertion fails, delete the newly written file and report failure. This keeps
failed generation from leaving an indexed or orphaned result.

The generated Markdown uses existing frontmatter fields (`title`, `type`,
`createdAt`, `updatedAt`) plus a body containing project ID, optional run ID,
source artifact IDs, cases, source excerpts, coverage status, gaps, and
warnings. The SQLite artifact type is `generated-test-plan`.

## CLI

```text
nova generate --project <projectId> [--run <runId>] [--artifact <artifactId...>]
  [--title "Generated requirements test plan"] [--database <path>]
```

The command prints the stored `Artifact` metadata and the validated
`RequirementsTestPlan` JSON. It uses the same license and repository resource
handling as `discover`. Error handling follows the existing `LicenseError` and
`ProjectNotFoundError` pattern. No new flag supplies a repository path,
credentials, a URL to fetch, or a content upload.

## Coverage mapping rules

Mapping is conservative and explainable:

- `mapped`: a requirement case has one or more directly relevant discovered
  paths and the rationale identifies the evidence (route, title, heading, or
  control label).
- `partial`: evidence maps to part of the case but required behavior, state,
  role, or endpoint was not observed.
- `unmapped`: the document describes behavior that discovery did not expose.
- `not-applicable`: no snapshot was requested.

A mapper may use path/title/heading/control text comparison, but it must not
claim semantic verification from a string match alone. Each `unmapped` or
`partial` case adds a human-readable item to `gaps`; gaps are review work,
not automatic bug reports.

## Audit and observability

Generation records project ID, selected artifact IDs, optional run ID,
generated artifact ID, model/provider identifier (if configured), duration,
case count, and coverage counts. Do not log full artifact contents, excerpts,
secrets, or model prompts/responses by default. Persist generation audit events
in a dedicated project-generation event store in the implementation milestone;
do not overload `run_events`, since generation can occur without a run.

## Test plan

Add unit and integration coverage for:

- rejecting unknown projects, foreign artifacts, missing files, escaped paths,
  empty inputs, and runs that do not belong to the project;
- schema validation failure from the generator adapter;
- traceability: every persisted case has at least one matching source artifact
  and bounded excerpt;
- `mapped`, `partial`, `unmapped`, and no-snapshot `not-applicable` coverage;
- state-changing or ambiguous cases requiring approval;
- atomic disk/SQLite persistence and compensation when SQLite insertion fails;
- CLI JSON output with a temporary database and project artifact directory;
- regression: the current `discover` and `HarnessWorkflow` behavior is
  unchanged.

## Rollout sequence

1. Add schemas, generator contract, deterministic fixture generator, and tests.
2. Add artifact loading, path containment validation, and generated Markdown
   renderer with atomic persistence.
3. Add conservative discovery mapper and coverage/gap tests.
4. Add the CLI command and audit events.
5. Add an injected LLM adapter only after prompt-injection tests, fixture-based
   evaluation cases, provider configuration, and failure handling are agreed.
6. Design reviewed-case conversion into executable plans as a separate,
   approval-gated milestone.
