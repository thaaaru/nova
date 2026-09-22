import { randomUUID } from "node:crypto";

import type {
  ApprovalSubmission,
  ApprovedPlanSnapshot,
  ExecutionRequest,
  TestRunState,
} from "../../domain/index.js";
import { ApprovalSubmissionSchema, NOVA_POLICY_VERSION } from "../../domain/index.js";
import { sha256Of } from "../hash.js";

/**
 * Everything the approval page submits is re-verified here, server-side,
 * against the run Nova actually holds. Browser state is never
 * authoritative: the page can only ever propose a decision, and this
 * module decides whether that decision is one Nova will record.
 *
 * Nothing in this file starts an execution. Minting the immutable
 * approval snapshot and minting the execution request are two separate
 * functions, called at two separate times, by two separate human
 * actions.
 */

export type DecisionFailure = {
  code:
    | "invalid_payload"
    | "unknown_plan"
    | "stale_plan"
    | "target_mismatch"
    | "environment_mismatch"
    | "scope_mismatch"
    | "unknown_case"
    | "no_selection"
    | "already_decided";
  message: string;
};

export type DecisionResult =
  { ok: true; snapshot: ApprovedPlanSnapshot } | { ok: false; failure: DecisionFailure };

export type VerifyDecisionOptions = {
  run: TestRunState;
  /** Raw, untrusted JSON straight off the wire. */
  payload: unknown;
  reviewer: string;
  /** The target/environment/scope the page was rendered for — must still match the run. */
  expected: { target: string; environment: string; scopeDomains: string[] };
};

export function verifyAndRecordDecision(options: VerifyDecisionOptions): DecisionResult {
  const parsed = ApprovalSubmissionSchema.safeParse(options.payload);
  if (!parsed.success) {
    return { ok: false, failure: { code: "invalid_payload", message: parsed.error.message } };
  }
  const submission: ApprovalSubmission = parsed.data;
  const run = options.run;

  if (!run.testPlan || !run.planHash) {
    return { ok: false, failure: { code: "unknown_plan", message: "This run has no validated plan." } };
  }
  if (submission.planId !== run.testPlan.id) {
    return { ok: false, failure: { code: "unknown_plan", message: "Plan id does not match this run." } };
  }
  // The single most important check on this path: a page rendered against
  // an older version of the plan cannot approve the current one.
  if (submission.planHash !== run.planHash) {
    return {
      ok: false,
      failure: {
        code: "stale_plan",
        message: "This review page is out of date — the plan has changed since it was opened.",
      },
    };
  }
  if (run.approvedPlanSnapshot) {
    return {
      ok: false,
      failure: { code: "already_decided", message: "A decision has already been recorded for this plan." },
    };
  }
  if (options.expected.target !== run.targetManifest.baseUrl) {
    return { ok: false, failure: { code: "target_mismatch", message: "Target no longer matches the run." } };
  }
  if (options.expected.environment !== run.targetManifest.environment) {
    return {
      ok: false,
      failure: { code: "environment_mismatch", message: "Environment no longer matches the run." },
    };
  }
  if (options.expected.scopeDomains.join(",") !== run.targetManifest.allowedDomains.join(",")) {
    return { ok: false, failure: { code: "scope_mismatch", message: "Scope no longer matches the run." } };
  }

  const planCaseIds = new Set(run.testPlan.cases.map((testCase) => testCase.id));
  const unknown = [...submission.selectedTestCaseIds, ...submission.excludedTestCaseIds].filter(
    (id) => !planCaseIds.has(id),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      failure: { code: "unknown_case", message: `Not part of this plan: ${unknown.join(", ")}` },
    };
  }
  if (submission.decision === "approved" && submission.selectedTestCaseIds.length === 0) {
    return {
      ok: false,
      failure: { code: "no_selection", message: "Approving requires at least one selected test case." },
    };
  }

  // Exclusions are derived, never taken on trust: whatever was not
  // selected is excluded, whatever the page claimed.
  const selected = new Set(submission.selectedTestCaseIds);
  const excluded = run.testPlan.cases.map((testCase) => testCase.id).filter((id) => !selected.has(id));

  const core = {
    approvalId: `APV-${randomUUID().slice(0, 8).toUpperCase()}`,
    planId: run.testPlan.id,
    planHash: run.planHash,
    decision: submission.decision,
    reviewer: options.reviewer,
    decidedAt: new Date().toISOString(),
    selectedTestCaseIds: submission.decision === "approved" ? submission.selectedTestCaseIds : [],
    excludedTestCaseIds: submission.decision === "approved" ? excluded : [],
    comment: submission.comment,
    target: run.targetManifest.baseUrl,
    environment: run.targetManifest.environment,
    scopeDomains: run.targetManifest.allowedDomains,
    projectId: run.projectId,
    policyVersion: NOVA_POLICY_VERSION,
    promptVersion: run.identification?.promptVersion,
    model: run.identification?.model,
    provider: run.identification?.provider,
  };

  return { ok: true, snapshot: { ...core, snapshotHash: sha256Of(core) } };
}

/**
 * The separate, explicitly requested authorization to run what was
 * approved. `idempotencyKey` is a content hash of exactly what the run
 * will do, so a double press can never produce two runs of the same
 * work, and a changed selection is correctly a different request.
 */
export function createExecutionRequest(options: {
  run: TestRunState;
  snapshot: ApprovedPlanSnapshot;
  requestedBy: string;
  /** Defaults to everything the approval selected. */
  selectedTestCaseIds?: string[];
}): ExecutionRequest {
  const { run, snapshot } = options;
  if (snapshot.decision !== "approved") {
    throw new Error("An execution request can only be created from an approved plan.");
  }
  const approved = new Set(snapshot.selectedTestCaseIds);
  const selectedTestCaseIds = (options.selectedTestCaseIds ?? snapshot.selectedTestCaseIds).filter((id) =>
    approved.has(id),
  );
  if (selectedTestCaseIds.length === 0) {
    throw new Error("An execution request must select at least one approved test case.");
  }

  const idempotencyKey = sha256Of({
    planHash: snapshot.planHash,
    approvalId: snapshot.approvalId,
    selectedTestCaseIds: [...selectedTestCaseIds].sort(),
  });

  return {
    executionRequestId: `EXR-${idempotencyKey.slice(0, 8).toUpperCase()}`,
    planId: snapshot.planId,
    planHash: snapshot.planHash,
    approvalId: snapshot.approvalId,
    selectedTestCaseIds,
    target: run.targetManifest.baseUrl,
    environment: run.targetManifest.environment,
    scopeDomains: run.targetManifest.allowedDomains,
    policyVersion: NOVA_POLICY_VERSION,
    requestedAt: new Date().toISOString(),
    requestedBy: options.requestedBy,
    idempotencyKey,
  };
}
