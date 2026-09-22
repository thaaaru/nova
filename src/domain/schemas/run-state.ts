import { z } from "zod";

import { ArtifactReferenceSchema, AuditEventSchema } from "./audit.js";
import { DiscoverySnapshotSchema } from "./discovery.js";
import { ExecutionResultSchema, VerificationResultSchema } from "./execution.js";
import { ApprovalSchema, TestPlanSchema } from "./plan.js";
import { TargetManifestSchema } from "./manifest.js";
import { TestMapRunContextSchema } from "./test-map.js";
import { ApplicationEvidencePackageSchema, IdentificationArtifactSchema } from "./identification.js";
import { ApprovedPlanSnapshotSchema, ExecutionRequestSchema } from "./approval.js";
import { SuggestedTestPlanSchema } from "./suggestion.js";

/**
 * Every status the guided workflow can persist. The original
 * discover/plan/approve/run statuses are unchanged (every existing CLI
 * command, report, and test still reads them); the guided flow's earlier
 * context/authentication/identification stages and its post-approval
 * execution-request/preflight/pause stages are additions, not
 * replacements. This enum is the only state machine — nothing outside
 * LangGraph's routing consults a second one.
 */
export const RunStatusSchema = z.enum([
  "new",
  "context_discovery",
  "authentication_required",
  "authenticated",
  "document_discovery",
  "application_identification",
  "identification_confirmation",
  "discovering",
  "planning",
  "awaiting_approval",
  "approved",
  "changes_requested",
  "rejected",
  "execution_requested",
  "preflight",
  "executing",
  "verifying",
  "paused",
  "stopped",
  "completed",
  "failed",
  "blocked",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * The single durable state object threaded through every LangGraph node.
 * Every node reads its inputs from here and writes its outputs back here
 * — there is no side-channel state. RunRepository is the only thing that
 * persists it; the graph itself holds no state between invocations.
 */
export const TestRunStateSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().uuid(),
  targetManifest: TargetManifestSchema,
  objective: z.string().min(1).optional(),
  /** Set by probe_entry_context/ensure_authentication; "public_only" means the operator declined to sign in. */
  authenticationMode: z.enum(["not_required", "browser_session", "saved_profile", "public_only"]).optional(),
  /** Opaque path to a captured Playwright session — never cookies, tokens, or credentials themselves. */
  authenticationReason: z.string().optional(),
  /** Bounded, sanitized observations handed to the identification model. */
  evidencePackage: ApplicationEvidencePackageSchema.optional(),
  /** Versioned, schema-validated, evidence-checked identification artifact. */
  identification: IdentificationArtifactSchema.optional(),
  discoverySnapshot: DiscoverySnapshotSchema.optional(),
  testPlan: TestPlanSchema.optional(),
  /** The reviewable form of the plan: every accepted suggestion's review metadata, plus what validation rejected and why. */
  suggestions: SuggestedTestPlanSchema.optional(),
  /** Incremented each time a "changes requested" decision sends the plan back for revision. */
  revisionCount: z.number().int().min(0).optional(),
  /** sha256 over the canonicalized testPlan — computed in code, bound into every approval. */
  planHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Set only for runs launched from the Application Test Map (nova journey run / TUI); absent for the plain discover/plan/approve/run CLI path. */
  testMapContext: TestMapRunContextSchema.optional(),
  approval: ApprovalSchema.optional(),
  /** Immutable record of the reviewer's decision, minted server-side from a verified submission. */
  approvedPlanSnapshot: ApprovedPlanSnapshotSchema.optional(),
  /** Separate, explicitly requested, idempotent authorization to actually run the approved snapshot. */
  executionRequest: ExecutionRequestSchema.optional(),
  executionResults: z.array(ExecutionResultSchema).default([]),
  verificationResults: z.array(VerificationResultSchema).default([]),
  artifactReferences: z.array(ArtifactReferenceSchema).default([]),
  auditEvents: z.array(AuditEventSchema).default([]),
  status: RunStatusSchema,
});
export type TestRunState = z.infer<typeof TestRunStateSchema>;
