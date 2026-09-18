import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { discoverApplication } from "../services/browser/discover.js";
import { executeTestCase } from "../services/browser/execute.js";
import { EnvSecretResolver } from "../services/policy/secret-resolver.js";
import { SqliteRunRepository, type RunRepository } from "../services/persistence/run-repository.js";
import { loadConfig, type NovaConfig } from "../config/index.js";
import { buildNovaGraph, type NovaGraph } from "../workflow/graph.js";

export type NovaRuntime = {
  config: NovaConfig;
  repository: RunRepository;
  graph: NovaGraph;
};

export function buildRuntime(overrides: Partial<NovaConfig> = {}): NovaRuntime {
  const config = loadConfig(overrides);
  const repository = new SqliteRunRepository(config.databasePath);
  const secretResolver = new EnvSecretResolver();
  const checkpointDatabasePath = config.databasePath.replace(/\.sqlite$/, "") + "-checkpoints.sqlite";

  const graph = buildNovaGraph({
    discover: { discover: discoverApplication, headless: config.headless },
    execute: {
      executeTestCase,
      secretResolver,
      artifactsDirectory: config.artifactsDirectory,
      headless: config.headless,
    },
    report: { artifactsDirectory: config.artifactsDirectory },
    checkpointDatabasePath,
  });

  return { config, repository, graph };
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
