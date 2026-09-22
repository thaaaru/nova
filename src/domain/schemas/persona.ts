import { z } from "zod";

/**
 * Whether a persona's captured session material can still be replayed
 * without the operator re-authenticating. `ready` means the vaulted
 * session (see `services/security/session-vault.ts`) is present and
 * not known to have expired; `expired` means the last captured session
 * is stale and must be recaptured; `needs_login` means no session has
 * ever been captured for this persona.
 */
export const PersonaSessionStatusSchema = z.enum(["ready", "expired", "needs_login"]);
export type PersonaSessionStatus = z.infer<typeof PersonaSessionStatusSchema>;

/**
 * How a persona's identity/session material is obtained: `browser_login`
 * drives a real headed browser login captured into the session vault;
 * `external_reference` points at credentials or a session managed
 * outside Nova (e.g. an operator-supplied token or account reference).
 */
export const PersonaMethodSchema = z.enum(["browser_login", "external_reference"]);
export type PersonaMethod = z.infer<typeof PersonaMethodSchema>;

/**
 * A ProjectPersona is a QA engineer's reusable named test identity —
 * e.g. "Admin User" or "Guest Checkout" — scoped to a single Project so
 * the same login/session doesn't need to be rediscovered for every
 * Application Test Map in that project. When captured via
 * `browser_login`, `vaultRef` is an opaque pointer into the local
 * encrypted session vault (see `services/security/session-vault.ts`):
 * it identifies where the persona's captured storageState lives on
 * disk, but it is never itself credential material and is never
 * rendered to the operator. `reference` is used instead for
 * `external_reference` personas, holding an operator-facing pointer
 * (e.g. an account name) rather than any secret.
 */
export const ProjectPersonaSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  method: PersonaMethodSchema,
  sessionStatus: PersonaSessionStatusSchema.default("needs_login"),
  vaultRef: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastVerifiedAt: z.string().datetime().optional(),
});
export type ProjectPersona = z.infer<typeof ProjectPersonaSchema>;
