import { z } from "zod";

/**
 * The approved scope for a target application. Enforced in code (see
 * services/policy) — never passed to a model as something it could talk
 * its way around; the model only ever sees "allowed" or "blocked," never
 * the ability to decide which.
 */
export const TargetManifestSchema = z.object({
  targetId: z.string().min(1),
  baseUrl: z.string().url(),
  allowedDomains: z.array(z.string().min(1)).min(1),
  environment: z.string().min(1).default("staging"),
  description: z.string().default(""),
  createdAt: z.string().datetime(),
});
export type TargetManifest = z.infer<typeof TargetManifestSchema>;
