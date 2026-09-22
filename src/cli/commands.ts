import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import {
  TargetManifestSchema,
  type ApplicationIdentification,
  type ApprovedPlanSnapshot,
  type RunExecutionMode,
  type TargetManifest,
  type TestRunState,
} from "../domain/index.js";
import { createExecutionRequest } from "../services/approval/decision.js";
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

/**
 * The guided workflow's service surface. `nova test`, the TUI, and any
 * future MCP tool all drive the workflow exclusively through these
 * functions: each one records a human decision onto the persisted run
 * and then re-invokes the same LangGraph graph, which resumes at
 * whichever node that decision unblocked. No presentation layer ever
 * reimplements a transition, and no transition happens without the
 * decision that authorizes it.
 */

export type GuidedRunInput = {
  target: string;
  objective?: string;
  environment?: string;
  allowedDomains?: string[];
  runExecutionMode?: RunExecutionMode;
  projectId?: string;
  tenantId?: string;
  description?: string;
};

/** Creates a brand-new guided run and advances it as far as it can go without a human. */
export async function startGuidedRun(runtime: NovaRuntime, input: GuidedRunInput): Promise<TestRunState> {
  const hostname = new URL(input.target).hostname;
  const manifest = TargetManifestSchema.parse({
    targetId: hostname,
    baseUrl: input.target,
    allowedDomains: input.allowedDomains ?? [hostname],
    environment: input.environment ?? "staging",
    description: input.description ?? `Guided run for ${input.target}`,
    runExecutionMode: input.runExecutionMode ?? "safe_test",
    createdAt: new Date().toISOString(),
  });

  const runId = randomUUID();
  const run: TestRunState = {
    tenantId: input.tenantId ?? "default",
    projectId: input.projectId ?? "default",
    runId,
    targetManifest: manifest,
    objective: input.objective,
    status: "new",
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [
      {
        timestamp: new Date().toISOString(),
        type: "run_started",
        detail: { targetUrl: input.target },
        actor: "operator",
      },
    ],
  };
  runtime.repository.save(run);
  setCurrentRunId(runtime.config, runId);
  return advanceGuidedRun(runtime, run);
}

/** Re-invokes the graph against the run as currently persisted, and persists whatever it produced. */
export async function advanceGuidedRun(runtime: NovaRuntime, run: TestRunState): Promise<TestRunState> {
  const result = await runtime.graph.invoke({ run }, { configurable: { thread_id: run.runId } });
  runtime.repository.save(result.run);
  return result.run;
}

function requireRun(runtime: NovaRuntime, runId: string): TestRunState {
  const run = runtime.repository.get(runId);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  return run;
}

/**
 * Records which of the three authentication choices the operator made.
 * The session material itself is captured by the existing secure
 * `nova login` path and referenced only by an opaque storage-state path;
 * nothing here ever sees a cookie, token, or credential.
 */
export async function chooseAuthentication(
  runtime: NovaRuntime,
  runId: string,
  choice: "browser_session" | "saved_profile" | "public_only",
  storageStatePath?: string,
): Promise<TestRunState> {
  const run = requireRun(runtime, runId);
  if (choice !== "public_only" && !storageStatePath) {
    throw new Error(`Authentication choice "${choice}" requires a captured session.`);
  }
  return advanceGuidedRun(runtime, {
    ...run,
    authenticationMode: choice,
    targetManifest: storageStatePath ? { ...run.targetManifest, storageStatePath } : run.targetManifest,
  });
}

/**
 * The human confirmation of the application identification. An operator
 * edit replaces the model's answer entirely and is recorded as such —
 * the artifact's `source` becomes "operator_edit", so a reader can
 * always tell which claims a person stands behind.
 */
export async function confirmIdentification(
  runtime: NovaRuntime,
  runId: string,
  confirmedBy: string,
  edited?: Partial<ApplicationIdentification>,
): Promise<TestRunState> {
  const run = requireRun(runtime, runId);
  if (!run.identification) {
    throw new Error(`Run ${runId} has no identification to confirm yet.`);
  }
  const identification = edited
    ? { ...run.identification.identification, ...edited }
    : run.identification.identification;

  return advanceGuidedRun(runtime, {
    ...run,
    identification: {
      ...run.identification,
      identification,
      source: edited ? "operator_edit" : run.identification.source,
      version: edited ? run.identification.version + 1 : run.identification.version,
      confirmedBy,
      confirmedAt: new Date().toISOString(),
    },
  });
}

/** Sets the objective a plan is generated against, then advances. */
export async function setObjective(
  runtime: NovaRuntime,
  runId: string,
  objective: string,
): Promise<TestRunState> {
  const run = requireRun(runtime, runId);
  return advanceGuidedRun(runtime, { ...run, objective });
}

/**
 * Records a decision made in the local HTML review page. The snapshot is
 * already verified server-side (see services/approval/decision.ts); this
 * function binds it onto the run and lets the graph apply the
 * corresponding transition. It never executes anything.
 */
export async function recordApprovalDecision(
  runtime: NovaRuntime,
  runId: string,
  snapshot: ApprovedPlanSnapshot,
): Promise<TestRunState> {
  const run = requireRun(runtime, runId);
  return advanceGuidedRun(runtime, {
    ...run,
    approvedPlanSnapshot: snapshot,
    approval: {
      planId: snapshot.planId,
      decision: snapshot.decision,
      reviewer: snapshot.reviewer,
      decidedAt: snapshot.decidedAt,
      note: snapshot.comment.length > 0 ? snapshot.comment : undefined,
      approvalId: snapshot.approvalId,
      selectedTestCaseIds: snapshot.selectedTestCaseIds,
    },
  });
}

/**
 * The separate, explicit request to run what was approved — a different
 * audit event from the approval itself, bound to the plan hash, the
 * approval id, and exactly the selected case ids, and idempotent by
 * content hash so a double press cannot run the same work twice.
 */
export async function requestExecution(
  runtime: NovaRuntime,
  runId: string,
  requestedBy: string,
  selectedTestCaseIds?: string[],
): Promise<TestRunState> {
  const run = requireRun(runtime, runId);
  if (!run.approvedPlanSnapshot) {
    throw new Error(`Run ${runId} has no recorded approval to execute.`);
  }
  if (run.executionRequest) {
    // Same approval, same selection -> same request. Re-advancing is safe
    // and is how a resumed session picks an interrupted run back up.
    return advanceGuidedRun(runtime, run);
  }
  const executionRequest = createExecutionRequest({
    run,
    snapshot: run.approvedPlanSnapshot,
    requestedBy,
    selectedTestCaseIds,
  });
  return advanceGuidedRun(runtime, { ...run, executionRequest });
}
