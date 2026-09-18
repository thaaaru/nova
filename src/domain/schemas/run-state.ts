import { z } from "zod";

import { ArtifactReferenceSchema, AuditEventSchema } from "./audit.js";
import { DiscoverySnapshotSchema } from "./discovery.js";
import { ExecutionResultSchema, VerificationResultSchema } from "./execution.js";
import { ApprovalSchema, TestPlanSchema } from "./plan.js";
import { TargetManifestSchema } from "./manifest.js";

export const RunStatusSchema = z.enum([
  "discovering",
  "planning",
  "awaiting_approval",
  "approved",
  "rejected",
  "executing",
  "verifying",
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
  discoverySnapshot: DiscoverySnapshotSchema.optional(),
  testPlan: TestPlanSchema.optional(),
  approval: ApprovalSchema.optional(),
  executionResults: z.array(ExecutionResultSchema).default([]),
  verificationResults: z.array(VerificationResultSchema).default([]),
  artifactReferences: z.array(ArtifactReferenceSchema).default([]),
  auditEvents: z.array(AuditEventSchema).default([]),
  status: RunStatusSchema,
});
export type TestRunState = z.infer<typeof TestRunStateSchema>;
