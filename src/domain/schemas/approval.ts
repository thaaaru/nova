import { z } from "zod";

/**
 * The immutable approval record and the separate execution request that
 * follows it. Approving a plan and asking Nova to run it are two
 * distinct, separately audited events: nothing here ever starts a run.
 *
 * Everything a reviewer submits from the local HTML page arrives as an
 * `ApprovalSubmission` and is re-verified in code (plan hash, target,
 * environment, scope, token, membership of every selected id) before an
 * `ApprovedPlanSnapshot` is minted. Browser-side state is never trusted.
 */

export const ApprovalDecisionSchema = z.enum(["approved", "changes_requested", "rejected"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalSubmissionSchema = z.object({
  planId: z.string().min(1),
  /** sha256 over the canonicalized TestPlan the reviewer was actually shown. */
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  decision: ApprovalDecisionSchema,
  selectedTestCaseIds: z.array(z.string().min(1)).default([]),
  excludedTestCaseIds: z.array(z.string().min(1)).default([]),
  comment: z.string().max(4000).default(""),
});
export type ApprovalSubmission = z.infer<typeof ApprovalSubmissionSchema>;

/**
 * The frozen record of one decision. `snapshotHash` covers the fields a
 * later execution request must match, so an approval can be replayed for
 * audit but never silently re-pointed at a different target/plan.
 */
export const ApprovedPlanSnapshotSchema = z.object({
  approvalId: z.string().min(1),
  planId: z.string().min(1),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  decision: ApprovalDecisionSchema,
  reviewer: z.string().min(1),
  decidedAt: z.string().datetime(),
  selectedTestCaseIds: z.array(z.string().min(1)).default([]),
  excludedTestCaseIds: z.array(z.string().min(1)).default([]),
  comment: z.string().default(""),
  target: z.string().url(),
  environment: z.string().min(1),
  scopeDomains: z.array(z.string().min(1)).min(1),
  projectId: z.string().min(1),
  policyVersion: z.string().min(1),
  /** Provenance of the advisory model output the reviewer saw, when any was used. */
  promptVersion: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApprovedPlanSnapshot = z.infer<typeof ApprovedPlanSnapshotSchema>;

/**
 * Created only by an explicit human action in the TUI *after* approval.
 * `idempotencyKey` is derived from (planHash, approvalId, selected ids),
 * so pressing Enter twice can never produce two runs of the same work.
 */
export const ExecutionRequestSchema = z.object({
  executionRequestId: z.string().min(1),
  planId: z.string().min(1),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  approvalId: z.string().min(1),
  selectedTestCaseIds: z.array(z.string().min(1)).min(1),
  target: z.string().url(),
  environment: z.string().min(1),
  scopeDomains: z.array(z.string().min(1)).min(1),
  policyVersion: z.string().min(1),
  requestedAt: z.string().datetime(),
  requestedBy: z.string().min(1),
  idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

/** Bumped whenever the enforced policy rules in services/policy change shape. */
export const NOVA_POLICY_VERSION = "policy-1";
