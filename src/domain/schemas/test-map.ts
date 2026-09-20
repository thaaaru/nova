import { z } from "zod";

import { AssertionSchema, RiskLevelSchema, TestStepSchema } from "./plan.js";
import { RunExecutionModeSchema } from "./manifest.js";
import { RecoveryActionSchema } from "./recovery.js";

/**
 * The Application Test Map is the QA-facing product surface: a durable,
 * versioned catalogue of what an application does, who tests it, and what
 * data/scope that testing is allowed to touch. It never stores a
 * credential, token, PII, or payment value directly — only opaque
 * reference ids resolved elsewhere (see services/policy/secret-resolver.ts
 * for credentialReferenceId, and a fixture data provider for
 * dataReferenceId). Everything here is deterministic data; nothing in
 * this file is produced or consumed by a model.
 */

export const ExecutionModeLabelSchema = z.enum(["quick_test", "guided_test", "controlled_test"]);
export type ExecutionModeLabel = z.infer<typeof ExecutionModeLabelSchema>;

export const JourneyStatusSchema = z.enum(["draft", "approved", "deprecated"]);
export type JourneyStatus = z.infer<typeof JourneyStatusSchema>;

export const ApprovedScopeSchema = z.object({
  allowedDomains: z.array(z.string().min(1)).min(1),
  allowedApiHosts: z.array(z.string().min(1)).default([]),
  allowedMethods: z.array(z.string().min(1)).default(["GET", "POST"]),
  executionMode: RunExecutionModeSchema.default("safe_test"),
  /**
   * Path to a session file captured by `nova login` (cookies +
   * localStorage, never a credential) that every journey run against
   * this map should reuse to crawl/execute as a signed-in user.
   */
  storageStatePath: z.string().min(1).optional(),
});
export type ApprovedScope = z.infer<typeof ApprovedScopeSchema>;

export const EvidenceRequirementSchema = z.enum(["screenshot", "trace", "console_log", "api_response"]);
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;

export const CheckpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  expectedOutcome: z.string().min(1),
  riskLevel: RiskLevelSchema,
  requiresApproval: z.boolean().default(false),
  evidenceRequirements: z.array(EvidenceRequirementSchema).default(["screenshot"]),
  /** How this checkpoint is actually driven end to end — deterministic steps + assertions, never free text. */
  steps: z.array(TestStepSchema).default([]),
  assertions: z.array(AssertionSchema).default([]),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const TestPersonaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Opaque pointer resolved by SecretResolver at execution time — never a raw credential. */
  credentialReferenceId: z.string().min(1),
  permissions: z.array(z.string()).default([]),
  allowedEnvironments: z.array(z.string().min(1)).min(1),
});
export type TestPersona = z.infer<typeof TestPersonaSchema>;

export const TestDataFixtureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  setupAction: z.string().optional(),
  cleanupAction: z.string().optional(),
  /** Opaque pointer to the actual data record/provider — never inline PII or payment data. */
  dataReferenceId: z.string().min(1),
  lockRequired: z.boolean().default(false),
});
export type TestDataFixture = z.infer<typeof TestDataFixtureSchema>;

/**
 * A deterministic template for turning a journey's checkpoints into a
 * TestPlan case without re-deriving steps by hand every run. Optional —
 * a journey with no template still runs from its checkpoints' own
 * steps/assertions alone.
 */
export const TestTemplateSchema = z.object({
  preconditions: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(60_000),
});
export type TestTemplate = z.infer<typeof TestTemplateSchema>;

export const UserJourneySchema = z.object({
  id: z.string().min(1),
  areaId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  mode: ExecutionModeLabelSchema,
  requiredPersonaIds: z.array(z.string().min(1)).default([]),
  requiredFixtureIds: z.array(z.string().min(1)).default([]),
  checkpoints: z.array(CheckpointSchema).min(1),
  allowedRecoveryActions: z.array(RecoveryActionSchema).default([]),
  testTemplate: TestTemplateSchema.optional(),
  status: JourneyStatusSchema.default("draft"),
  /** Deterministic recommendation/regression bookkeeping — never touched by a model. */
  lastRunAt: z.string().datetime().optional(),
  lastRunOutcome: z.enum(["passed", "failed", "flaky", "blocked", "inconclusive"]).optional(),
});
export type UserJourney = z.infer<typeof UserJourneySchema>;

export const ApplicationAreaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  riskLevel: RiskLevelSchema,
  journeys: z.array(UserJourneySchema).default([]),
});
export type ApplicationArea = z.infer<typeof ApplicationAreaSchema>;

/**
 * A constraint discovery or a QA engineer recorded about the target —
 * e.g. a route that 404s, a form that can't yet be automated, a known
 * flaky dependency. Purely informational; never itself a policy gate.
 */
export const KnownConstraintSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  areaId: z.string().optional(),
  severity: z.enum(["info", "warning", "blocker"]).default("info"),
});
export type KnownConstraint = z.infer<typeof KnownConstraintSchema>;

export const ApplicationTestMapEnvironmentSchema = z.enum(["local", "development", "staging", "production"]);
export type ApplicationTestMapEnvironment = z.infer<typeof ApplicationTestMapEnvironmentSchema>;

export const ApplicationTestMapStatusSchema = z.enum(["draft", "accepted"]);
export type ApplicationTestMapStatus = z.infer<typeof ApplicationTestMapStatusSchema>;

export const ApplicationTestMapSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  applicationName: z.string().min(1),
  targetUrl: z.string().url(),
  environment: ApplicationTestMapEnvironmentSchema,
  approvedScope: ApprovedScopeSchema,
  areas: z.array(ApplicationAreaSchema).default([]),
  personas: z.array(TestPersonaSchema).default([]),
  fixtures: z.array(TestDataFixtureSchema).default([]),
  knownConstraints: z.array(KnownConstraintSchema).default([]),
  /** "draft" until a QA engineer accepts/edits an AI-drafted map (see discovery-to-map pipeline). */
  status: ApplicationTestMapStatusSchema.default("draft"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ApplicationTestMap = z.infer<typeof ApplicationTestMapSchema>;

/**
 * Reference recorded on a TestRunState so a run's exact provenance
 * (which map version, journey, persona, fixtures) is auditable after the
 * fact, even once the map itself has moved on to a newer version.
 */
export const TestMapRunContextSchema = z.object({
  mapId: z.string().min(1),
  mapVersion: z.string().min(1),
  areaId: z.string().min(1),
  journeyId: z.string().min(1),
  personaId: z.string().optional(),
  fixtureIds: z.array(z.string().min(1)).default([]),
});
export type TestMapRunContext = z.infer<typeof TestMapRunContextSchema>;
