import { z } from "zod";

import { RecoveryAttemptSchema } from "./recovery.js";

export const StepResultSchema = z.object({
  stepIndex: z.number().int().min(0),
  status: z.enum(["passed", "failed", "skipped"]),
  error: z.string().optional(),
  durationMs: z.number().int().min(0),
});
export type StepResult = z.infer<typeof StepResultSchema>;

/**
 * Result of running one atomic TestCase's steps. Verification (below)
 * consumes this plus assertion outcomes to classify the case — execution
 * itself never decides pass/fail, only records what happened.
 */
export const ExecutionResultSchema = z.object({
  caseId: z.string().min(1),
  attempts: z.number().int().min(1),
  stepResults: z.array(StepResultSchema),
  assertionResults: z.array(
    z.object({
      kind: z.string(),
      expected: z.string(),
      passed: z.boolean(),
      observed: z.string().optional(),
    }),
  ),
  recoveryAttempts: z.array(RecoveryAttemptSchema).default([]),
  screenshots: z.array(z.string()),
  consoleLogs: z.array(z.string()),
  tracePath: z.string().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  error: z.string().optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const VerificationClassificationSchema = z.enum([
  "passed",
  "failed",
  "flaky",
  "blocked",
  "inconclusive",
]);
export type VerificationClassification = z.infer<typeof VerificationClassificationSchema>;

export const DefectCandidateSchema = z.object({
  title: z.string(),
  description: z.string(),
  evidenceRefs: z.array(z.string()),
});
export type DefectCandidate = z.infer<typeof DefectCandidateSchema>;

export const VerificationResultSchema = z.object({
  caseId: z.string().min(1),
  classification: VerificationClassificationSchema,
  evidenceRefs: z.array(z.string()),
  defectCandidate: DefectCandidateSchema.optional(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
