import { z } from "zod";

/**
 * Every state transition and policy decision is written here — this is
 * the durable record a compliance reviewer reads, independent of and
 * never overwritten by anything a model produced.
 */
export const AuditEventSchema = z.object({
  timestamp: z.string().datetime(),
  type: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).default({}),
  actor: z.string().default("system"),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const ArtifactReferenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["screenshot", "trace", "console_log", "report"]),
  path: z.string().min(1),
  caseId: z.string().optional(),
});
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
