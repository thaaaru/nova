import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { TargetManifestSchema, type TargetManifest, type TestRunState } from "../domain/index.js";
import { writeReportFiles, type WrittenReportPaths } from "../artifacts/write-reports.js";
import type { NovaRuntime } from "./context.js";
import { resolveRunId, setCurrentRunId } from "./context.js";

/**
 * Every command here returns a plain result object instead of writing to
 * stdout directly — `nova mcp serve` reuses these same functions, and
 * stdout is the MCP stdio JSON-RPC transport there; any incidental
 * process.stdout.write from application code would corrupt that stream.
 * The CLI entrypoint (src/cli/index.ts) is the only place these results
 * get printed.
 */

function loadManifest(
  target: string,
  manifestPath: string | undefined,
  storageState: string | undefined,
): TargetManifest {
  if (manifestPath) {
    if (!existsSync(manifestPath)) {
      throw new Error(`Manifest file not found: ${manifestPath}`);
    }
    const parsed = TargetManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    return storageState ? { ...parsed, storageStatePath: storageState } : parsed;
  }

  const hostname = new URL(target).hostname;
  return TargetManifestSchema.parse({
    targetId: hostname,
    baseUrl: target,
    allowedDomains: [hostname],
    environment: "local",
    description: `Auto-derived manifest for ${target} (no --manifest supplied).`,
    storageStatePath: storageState,
    createdAt: new Date().toISOString(),
  });
}

export type DiscoverResult = { runId: string; pageCount: number; visitedUrls: string[] };

export async function runDiscover(
  runtime: NovaRuntime,
  options: { target: string; manifest?: string; storageState?: string; headless?: boolean },
): Promise<DiscoverResult> {
  const manifest = loadManifest(options.target, options.manifest, options.storageState);
  const runId = randomUUID();
  const now = new Date().toISOString();

  const initial: TestRunState = {
    tenantId: "default",
    projectId: "default",
    runId,
    targetManifest: manifest,
    status: "discovering",
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [
      { timestamp: now, type: "run_started", detail: { targetUrl: options.target }, actor: "cli" },
    ],
  };
  runtime.repository.save(initial);

  const result = await runtime.graph.invoke({ run: initial }, { configurable: { thread_id: runId } });
  runtime.repository.save(result.run);
  setCurrentRunId(runtime.config, runId);

  return {
    runId,
    pageCount: result.run.discoverySnapshot?.pages.length ?? 0,
    visitedUrls: result.run.discoverySnapshot?.visitedUrls ?? [],
  };
}

export type PlanResult = {
  runId: string;
  planId: string;
  cases: Array<{ id: string; title: string; riskLevel: string; executionMode: string }>;
};

export async function runPlan(
  runtime: NovaRuntime,
  options: { objective: string; run?: string },
): Promise<PlanResult> {
  const runId = resolveRunId(runtime.config, options.run);
  const run = runtime.repository.get(runId);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }

  const updated: TestRunState = { ...run, objective: options.objective };
  runtime.repository.save(updated);

  const result = await runtime.graph.invoke({ run: updated }, { configurable: { thread_id: runId } });
  runtime.repository.save(result.run);

  const plan = result.run.testPlan;
  if (!plan) {
    throw new Error(`Planning did not produce a test plan for run ${runId}.`);
  }
  return {
    runId,
    planId: plan.id,
    cases: plan.cases.map((testCase) => ({
      id: testCase.id,
      title: testCase.title,
      riskLevel: testCase.riskLevel,
      executionMode: testCase.executionMode,
    })),
  };
}

export type ApproveResult = { runId: string; decision: "approved" | "rejected" };

export async function runApprove(
  runtime: NovaRuntime,
  options: { plan: string; reviewer?: string; reject?: boolean; note?: string },
): Promise<ApproveResult> {
  const runId = options.plan;
  const run = runtime.repository.get(runId);
  if (!run) {
    throw new Error(`Unknown plan: ${runId}`);
  }
  if (!run.testPlan) {
    throw new Error(`Run ${runId} has no test plan to approve yet. Run \`nova plan\` first.`);
  }

  const decision = options.reject ? "rejected" : "approved";
  const updated: TestRunState = {
    ...run,
    approval: {
      planId: run.testPlan.id,
      decision,
      reviewer: options.reviewer ?? process.env.NOVA_REVIEWER ?? "cli-operator",
      decidedAt: new Date().toISOString(),
      note: options.note,
    },
  };
  runtime.repository.save(updated);

  const result = await runtime.graph.invoke({ run: updated }, { configurable: { thread_id: runId } });
  runtime.repository.save(result.run);

  return { runId, decision };
}

export type ExecutionResultSummary = {
  runId: string;
  status: string;
  classificationCounts: Record<string, number>;
};

export async function runExecution(
  runtime: NovaRuntime,
  options: { plan: string; headless?: boolean },
): Promise<ExecutionResultSummary> {
  const runId = options.plan;
  const run = runtime.repository.get(runId);
  if (!run) {
    throw new Error(`Unknown plan: ${runId}`);
  }
  if (run.status !== "approved") {
    throw new Error(`Run ${runId} is "${run.status}"; only an approved plan can be executed.`);
  }

  const result = await runtime.graph.invoke({ run }, { configurable: { thread_id: runId } });
  runtime.repository.save(result.run);

  const classificationCounts = result.run.verificationResults.reduce<Record<string, number>>(
    (counts, verification) => {
      counts[verification.classification] = (counts[verification.classification] ?? 0) + 1;
      return counts;
    },
    {},
  );

  return { runId, status: result.run.status, classificationCounts };
}

export function runReport(runtime: NovaRuntime, options: { run: string }): WrittenReportPaths {
  const runId = options.run;
  const run = runtime.repository.get(runId);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  return writeReportFiles(run, runtime.config.artifactsDirectory);
}
