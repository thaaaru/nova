import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { discoverApplication } from "../services/browser/discover.js";
import { discoverDocuments } from "../services/browser/discover-documents.js";
import { detectAuthRequirement } from "../services/browser/detect-auth.js";
import { executeTestCase } from "../services/browser/execute.js";
import { EnvSecretResolver } from "../services/policy/secret-resolver.js";
import { buildEvidencePackage } from "../services/llm/evidence.js";
import { createApplicationIdentifier } from "../services/llm/identify-application.js";
import { createFileIdentificationCache } from "../services/llm/identification-cache.js";
import { createTestCaseSuggester } from "../services/llm/suggest-test-cases.js";
import { SqliteRunRepository, type RunRepository } from "../services/persistence/run-repository.js";
import {
  SqliteApplicationTestMapRepository,
  type ApplicationTestMapRepository,
} from "../services/persistence/test-map-repository.js";
import {
  SqliteProjectRepository,
  type ProjectRepository,
} from "../services/persistence/project-repository.js";
import {
  SqlitePersonaRepository,
  type PersonaRepository,
} from "../services/persistence/persona-repository.js";
import { loadConfig, type NovaConfig } from "../config/index.js";
import { buildNovaGraph, type NovaGraph } from "../workflow/graph.js";

export type NovaRuntime = {
  config: NovaConfig;
  repository: RunRepository;
  testMaps: ApplicationTestMapRepository;
  projects: ProjectRepository;
  personas: PersonaRepository;
  /** Directory `FileSessionVault` instances should use for this runtime's encrypted persona sessions. */
  sessionVaultDir: string;
  graph: NovaGraph;
  /**
   * Optional — omitted whenever no model is configured. When present,
   * `discoverMap` uses it to name/describe a freshly crawled application
   * from real, sanitized page evidence instead of the deterministic
   * URL-slug fallback. It is a thin adapter over the same
   * evidence-grounded identification chain the guided workflow uses.
   */
  appIdentifier?: AppIdentifier;
};

/** Names an application from a discovery snapshot; display metadata only, never a policy decision. */
export type AppIdentifier = (
  snapshot: Parameters<typeof buildEvidencePackage>[0]["snapshot"],
) => Promise<{ name: string; description: string }>;
export type RuntimeHooks = {
  /**
   * Fired at each meaningful discover/execute step. Left unset by default
   * — MCP and the TUI both call buildRuntime() with no hooks and stay
   * exactly as silent as before. Only the plain CLI commands that
   * explicitly want live progress (`nova discover`, `nova map discover`,
   * `nova run`, `nova journey run`) wire this to stderr.
   */
  onProgress?: (message: string) => void;
};

export function buildRuntime(overrides: Partial<NovaConfig> = {}, hooks: RuntimeHooks = {}): NovaRuntime {
  const config = loadConfig(overrides);
  const repository = new SqliteRunRepository(config.databasePath);
  const testMapDatabasePath = config.databasePath.replace(/\.sqlite$/, "") + "-test-map.sqlite";
  const testMaps = new SqliteApplicationTestMapRepository(testMapDatabasePath);
  const projectDatabasePath = config.databasePath.replace(/\.sqlite$/, "") + "-projects.sqlite";
  const projects = new SqliteProjectRepository(projectDatabasePath);
  const personaDatabasePath = config.databasePath.replace(/\.sqlite$/, "") + "-personas.sqlite";
  const personas = new SqlitePersonaRepository(personaDatabasePath);
  const sessionVaultDir = join(dirname(config.databasePath), "session-vault");
  const secretResolver = new EnvSecretResolver();
  const checkpointDatabasePath = config.databasePath.replace(/\.sqlite$/, "") + "-checkpoints.sqlite";

  // Every model-backed step is opt-in: wired only when a model is
  // configured (see config/index.ts). Without one, identification records
  // an honest degraded artifact and planning stays fully deterministic —
  // no key, no network call, no command that hard-fails.
  const identify = config.llm ? createApplicationIdentifier(config.llm) : undefined;
  const suggester = config.llm ? createTestCaseSuggester(config.llm) : undefined;

  const graph = buildNovaGraph({
    discover: { discover: discoverApplication, headless: config.headless, onProgress: hooks.onProgress },
    context: {
      detectAuth: detectAuthRequirement,
      discover: discoverApplication,
      headless: config.headless,
      onProgress: hooks.onProgress,
    },
    documents: { discoverDocuments, onProgress: hooks.onProgress },
    identification: {
      identify,
      cache: createFileIdentificationCache(join(dirname(config.databasePath), "identification-cache")),
      provider: config.llm?.provider,
      model: config.llm?.model,
      onProgress: hooks.onProgress,
    },
    plan: { suggester, onProgress: hooks.onProgress },
    execute: {
      executeTestCase,
      secretResolver,
      artifactsDirectory: config.artifactsDirectory,
      headless: config.headless,
      onProgress: hooks.onProgress,
    },
    report: { artifactsDirectory: config.artifactsDirectory },
    checkpointDatabasePath,
  });

  const appIdentifier: AppIdentifier | undefined = identify
    ? async (snapshot) => {
        const evidence = buildEvidencePackage({ runId: snapshot.runId, snapshot });
        const { identification } = await identify(evidence);
        return { name: identification.applicationName, description: identification.primaryPurpose };
      }
    : undefined;

  return { config, repository, testMaps, projects, personas, sessionVaultDir, graph, appIdentifier };
}

/**
 * A "current run" convenience pointer, so a single-operator interactive
 * session doesn't have to pass `--run`/`--plan` on every command — it is
 * always overridable by passing the id explicitly, and is never consulted
 * by anything except the CLI's own argument resolution.
 */
function currentRunPointerPath(config: NovaConfig): string {
  return join(dirname(config.databasePath), "current-run.json");
}

export function setCurrentRunId(config: NovaConfig, runId: string): void {
  const path = currentRunPointerPath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ runId }));
}

export function getCurrentRunId(config: NovaConfig): string | undefined {
  const path = currentRunPointerPath(config);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { runId?: string };
  return parsed.runId;
}

export function resolveRunId(config: NovaConfig, explicit: string | undefined): string {
  const runId = explicit ?? getCurrentRunId(config);
  if (!runId) {
    throw new Error(
      "No run id given and no current run is set. Pass --run/--plan explicitly, or run `nova discover` first.",
    );
  }
  return runId;
}
