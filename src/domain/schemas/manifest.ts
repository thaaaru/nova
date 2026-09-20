import { z } from "zod";

/**
 * The approved scope for a target application. Enforced in code (see
 * services/policy) — never passed to a model as something it could talk
 * its way around; the model only ever sees "allowed" or "blocked," never
 * the ability to decide which.
 */
export const RunExecutionModeSchema = z.enum(["observe", "safe_test", "destructive_test"]);
export type RunExecutionMode = z.infer<typeof RunExecutionModeSchema>;

export const TargetManifestSchema = z.object({
  targetId: z.string().min(1),
  baseUrl: z.string().url(),
  allowedDomains: z.array(z.string().min(1)).min(1),
  environment: z.string().min(1).default("staging"),
  description: z.string().default(""),
  /**
   * The ceiling for what this run may do: "observe" forbids every
   * state_changing case outright (read-only crawling/checks only);
   * "safe_test" (default) allows state_changing cases but only once
   * approved, same as today; "destructive_test" additionally allows
   * high-risk cases. Enforced in scope-policy, never left to a model.
   */
  runExecutionMode: RunExecutionModeSchema.default("safe_test"),
  /**
   * Path to a session file captured by `nova login` (cookies +
   * localStorage only, never a credential) so discovery/execution can
   * crawl as a signed-in user. Optional — omitted means public/anonymous.
   */
  storageStatePath: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
});
export type TargetManifest = z.infer<typeof TargetManifestSchema>;
