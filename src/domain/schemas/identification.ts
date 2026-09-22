import { z } from "zod";

/**
 * Evidence-grounded application identification. Everything in this file
 * describes what Nova *observed* and what a model *proposed* about it —
 * never what Nova is allowed to do. Identification is descriptive
 * metadata: it names the application under test, it never widens scope,
 * selects credentials, approves a plan, or authorizes execution. Those
 * remain code-only decisions in services/policy and the approval gate.
 */

export const EvidenceSourceTypeSchema = z.enum([
  "hostname",
  "page-title",
  "meta-description",
  "page-heading",
  "nav-label",
  "form-label",
  "login-characteristic",
  "route-pattern",
  "documentation",
  "openapi",
  "sitemap",
  "help-page",
  "api-operation",
  "project-document",
  "confirmed-project-info",
]);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

/**
 * One labelled, bounded, sanitized observation. `evidenceId` is stable
 * for a given package so the model's references can be checked against
 * it deterministically after the call returns.
 */
export const EvidenceItemSchema = z.object({
  evidenceId: z.string().regex(/^E-\d{3,}$/),
  sourceType: EvidenceSourceTypeSchema,
  source: z.string().min(1).max(300),
  content: z.string().min(1).max(400),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const ApplicationEvidencePackageSchema = z.object({
  runId: z.string().min(1),
  targetUrl: z.string().url(),
  capturedAt: z.string().datetime(),
  items: z.array(EvidenceItemSchema),
  /** sha256 over the sanitized items only — the identification cache key and the artifact's provenance anchor. */
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** True when per-item or total-size limits dropped observations that were otherwise eligible. */
  truncated: z.boolean().default(false),
  /** How many candidate observations were dropped outright because they looked secret-bearing. */
  redactedItemCount: z.number().int().min(0).default(0),
});
export type ApplicationEvidencePackage = z.infer<typeof ApplicationEvidencePackageSchema>;

const NamedWithEvidenceSchema = z.object({
  name: z.string().min(1).max(120),
  evidenceRefs: z.array(z.string()).default([]),
});

export const AuthenticationPatternSchema = z.object({
  type: z.string().min(1).max(80),
  evidenceRefs: z.array(z.string()).default([]),
});

/**
 * The exact shape the model is asked for. Deliberately permissive at the
 * *schema* level (any string is a valid evidenceRef here) — cross-checking
 * every reference against the package, and rejecting unsupported
 * conclusions, is `validateIdentification`'s job in code, not the model's.
 */
export const ApplicationIdentificationSchema = z.object({
  applicationName: z.string().min(1).max(120),
  applicationType: z.string().min(1).max(120),
  businessDomain: z.string().max(120).nullable().default(null),
  primaryPurpose: z.string().min(1).max(400),
  likelyPersonas: z.array(NamedWithEvidenceSchema).default([]),
  coreEntities: z.array(NamedWithEvidenceSchema).default([]),
  functionalAreas: z.array(NamedWithEvidenceSchema).default([]),
  likelyJourneys: z.array(NamedWithEvidenceSchema).default([]),
  authenticationPattern: AuthenticationPatternSchema.nullable().default(null),
  relevantDocuments: z.array(z.string().max(300)).default([]),
  assumptions: z.array(z.string().max(300)).default([]),
  unknowns: z.array(z.string().max(300)).default([]),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string()).default([]),
});
export type ApplicationIdentification = z.infer<typeof ApplicationIdentificationSchema>;

export const IdentificationSourceSchema = z.enum(["llm", "operator_edit", "degraded"]);
export type IdentificationSource = z.infer<typeof IdentificationSourceSchema>;

/**
 * The versioned discovery artifact that gets persisted on the run and
 * carried into the Application Model, the approval page, and the report.
 * Records provider/model/prompt/evidence provenance — never the prompt
 * text itself, and never a secret.
 */
export const IdentificationArtifactSchema = z.object({
  version: z.number().int().positive().default(1),
  identification: ApplicationIdentificationSchema,
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  provider: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  producedAt: z.string().datetime(),
  source: IdentificationSourceSchema,
  /** Deterministic validation notes (dropped refs, clamped confidence, rejected conclusions). */
  validationNotes: z.array(z.string()).default([]),
  confirmedBy: z.string().min(1).optional(),
  confirmedAt: z.string().datetime().optional(),
});
export type IdentificationArtifact = z.infer<typeof IdentificationArtifactSchema>;
