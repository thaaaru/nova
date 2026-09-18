import { z } from "zod";

/**
 * One bounded, deterministic recovery attempt made by the executor when a
 * step's declared locator no longer resolves. Recovery never touches scope,
 * secrets, or approval — it only tries alternate *ways to find the same
 * declared element* (role+name, visible text, label) on the same page, and
 * is capped by `recoveryBudget` on the TestCase. It is not an LLM call: the
 * strategy order is fixed code, not a model decision, so it carries none of
 * the "the model could talk its way around scope" risk the rest of the
 * execution path is designed to avoid.
 */
export const RecoveryOutcomeSchema = z.enum(["recovered", "exhausted", "blocked_by_policy"]);
export type RecoveryOutcome = z.infer<typeof RecoveryOutcomeSchema>;

export const RecoveryAttemptSchema = z.object({
  stepIndex: z.number().int().min(0),
  checkpoint: z.string(),
  failureSummary: z.string(),
  evidenceSummary: z.string(),
  action: z.string(),
  attempt: z.number().int().min(1),
  maxAttempts: z.number().int().min(1),
  outcome: RecoveryOutcomeSchema,
});
export type RecoveryAttempt = z.infer<typeof RecoveryAttemptSchema>;
