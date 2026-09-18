# Artifact store design

## Context

Nova currently generates its test plan bottom-up: `discover` crawls the
live site and `HeuristicTestPlanner` (`src/planning/heuristic-planner.ts`)
builds a plan purely from what it finds in the DOM. That plan can only
describe what's _currently rendered_ — it has no way to know what the
application is _supposed_ to do per its actual requirements.

The goal is to let a future test-case-generation agent read requirements-type
documents (DSRS, DSTS, use cases, OpenAPI specs) to generate test cases
top-down — from stated intent, not just observed markup — then use discovery
to map those cases onto real pages and flag gaps ("the DSRS specifies a
password-reset flow; discovery didn't find one").

**This spec covers the artifact store only**: a place for those source
documents (and, later, the test specs generated from them) to live,
persistently, tied to a reusable "project" rather than a one-off run. It
deliberately does **not** design the generation agent itself, or the
query/retrieval interface such an agent would use — those are separate,
future work, to be brainstormed once the store exists to build against.

## Data model

New types in `src/domain.ts`, following the existing zod-schema-as-source-of-truth
pattern already used for every other domain type:

```ts
export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  targetUrl: z.string().url().optional(),
  createdAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ArtifactTypeSchema = z.enum([
  "requirements", // DSRS-style
  "test-spec", // DSTS-style, human-authored
  "use-case",
  "api-spec", // OpenAPI/GraphQL schema, etc.
  "generated-test-plan", // reserved: output of a future generation agent
  "other",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  type: ArtifactTypeSchema,
  title: z.string().trim().min(1).max(200),
  filePath: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
```

`runs` needs **no schema migration at all** for this: `HarnessRunInputSchema`
(in `src/domain.ts`) is stored whole as the `input_json` blob in
`run-repository.ts` (confirmed by reading it, not assumed) — adding an
optional `projectId?: string` to that schema makes it flow through
automatically. No DB-enforced foreign key to `projects.id` (see Storage below
for why); existence is validated at the application layer instead.

## Storage

**Content on disk, metadata in SQLite** — the same split already used for
execution screenshots (`screenshotPath` in the DB, the PNG on disk).

- Files: `projects/<projectId>/artifacts/<artifactId>-<slug>.md`, each with a
  small YAML frontmatter header (`title`, `type`, `createdAt`, `updatedAt`) so
  the file is self-describing even without the database — and the SQLite
  index could be rebuilt from disk if it were ever lost. Plain Markdown only
  (confirmed scope: no PDF/DOCX parsing, no binary uploads). This also means
  these documents — which often go through a real review/sign-off process —
  can be versioned and reviewed with plain git, outside the tool.
- Metadata: a new `ProjectRepository` class in `src/storage/project-repository.ts`,
  structured exactly like the existing `RunRepository`
  (`src/storage/run-repository.ts`): takes a database path, opens its own
  `better-sqlite3` connection, runs its own idempotent
  `CREATE TABLE IF NOT EXISTS` migration, same physical `data/harness.sqlite`
  file as `RunRepository` by default.

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

No DB-enforced foreign key from `runs.project_id` (or `artifacts.project_id`)
to `projects.id` — `ProjectRepository` and `RunRepository` are two
independently-migrating classes sharing one file; a hard FK would couple
their migration order. Existence is validated at the application layer
instead (look the project up, fail closed with a clear error if missing —
same pattern as the existing `LicenseError` handling in `src/cli.ts`).

## CLI commands

New subcommands in `src/cli.ts`, following the existing command style
(commander, `withWorkflow`-style resource handling, JSON to stdout):

```
nova project create --name "TekLab website" [--url https://teklab.dev]
nova project list
nova project show <projectId>

nova artifact add <projectId> --type requirements --title "DSRS v1.2" --file ./dsrs.md
nova artifact list <projectId> [--type requirements]
nova artifact show <artifactId>
```

`discover` gains an optional `--project <projectId>` flag, storing it on the
run. Optional, not required — today's plain `discover --url ...` keeps
working exactly as it does now; projects are opt-in. For now this only
plumbs the connection between a run and its project; it doesn't change
discovery's behavior (that's the future generation agent's job).

## Errors

- Unknown `projectId` anywhere it's referenced (`artifact add`,
  `project show`, `discover --project`) → clear "Project not found" message,
  exit 1. Fails closed rather than silently proceeding unlinked.
- Invalid `--type` → rejected by the zod enum, valid options listed in the
  error.
- `--file` pointing to a missing file → clear error before anything is
  written to disk or the database.

## Testing

New `tests/project-repository.test.ts`, mirroring the existing repository
test style (e.g. `tests/public-navigation-executor.test.ts`'s use of a temp
directory): create a project, add an artifact, verify both the SQLite row
and the `.md` file (with correct frontmatter) land correctly, list/filter
artifacts by type, confirm looking up an unknown project id fails clearly.

## Explicitly out of scope

- The test-case-generation agent itself, and how it would query/consume this
  store — separate future design.
- PDF/DOCX/binary artifact ingestion — plain Markdown only, confirmed.
- A DB-enforced relationship between runs/artifacts and projects — validated
  in application code instead, to keep the two repository classes
  independently migratable.
