import { z } from "zod";

import { WEB_APP_BASELINE_PRESET } from "./goal-presets.js";

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  targetUrl: z.string().url().optional(),
  createdAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ArtifactTypeSchema = z.enum([
  "requirements",
  "test-spec",
  "use-case",
  "api-spec",
  "generated-test-plan",
  "other",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  type: ArtifactTypeSchema,
  title: z.string().trim().min(1).max(200),
  filePath: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const RunStatusSchema = z.enum([
  "discovering",
  "planning",
  "awaiting_approval",
  "ready_to_execute",
  "executing",
  "passed",
  "rejected",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RiskLevelSchema = z.enum(["read_only", "session_change", "state_change"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RequirementSourceSchema = z.object({
  artifactId: z.string().uuid(),
  filePath: z.string(),
  section: z.string().trim().min(1).max(500),
  excerpt: z.string().trim().min(1).max(2_000),
});
export type RequirementSource = z.infer<typeof RequirementSourceSchema>;

export const RequirementCoverageSchema = z.object({
  status: z.enum(["mapped", "partial", "unmapped", "not-applicable"]),
  discoveredPaths: z.array(z.string()),
  rationale: z.string().trim().min(1).max(2_000),
});
export type RequirementCoverage = z.infer<typeof RequirementCoverageSchema>;

export const GeneratedTestCaseSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(2_000),
  preconditions: z.array(z.string().trim().min(1).max(500)),
  steps: z.array(z.string().trim().min(1).max(2_000)).min(1),
  expectedResult: z.string().trim().min(1).max(2_000),
  risk: RiskLevelSchema,
  requiresApproval: z.boolean(),
  sources: z.array(RequirementSourceSchema).min(1),
  coverage: RequirementCoverageSchema,
});
export type GeneratedTestCase = z.infer<typeof GeneratedTestCaseSchema>;

export const RequirementsTestPlanSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
  artifactIds: z.array(z.string().uuid()).min(1),
  summary: z.string().trim().min(1).max(4_000),
  cases: z.array(GeneratedTestCaseSchema).min(1),
  gaps: z.array(z.string().trim().min(1).max(2_000)),
  warnings: z.array(z.string().trim().min(1).max(2_000)),
});
export type RequirementsTestPlan = z.infer<typeof RequirementsTestPlanSchema>;

export const ControlKindSchema = z.enum([
  "link",
  "button",
  "textbox",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "dialog",
  "heading",
  "form",
  "other",
]);

export const DiscoveredControlSchema = z.object({
  kind: ControlKindSchema,
  role: z.string().optional(),
  label: z.string().optional(),
  name: z.string().optional(),
  inputType: z.string().optional(),
  disabled: z.boolean(),
});
export type DiscoveredControl = z.infer<typeof DiscoveredControlSchema>;

export const PageSnapshotSchema = z.object({
  url: z.string().url(),
  path: z.string(),
  title: z.string(),
  headings: z.array(z.string()),
  controls: z.array(DiscoveredControlSchema),
  links: z.array(z.string().url()),
  consoleErrors: z.array(z.string()),
  pageErrors: z.array(z.string()),
  fingerprint: z.string(),
  screenshotPath: z.string().optional(),
});
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;

export const AppSnapshotSchema = z.object({
  id: z.string().uuid(),
  targetUrl: z.string().url(),
  discoveredAt: z.string().datetime(),
  pages: z.array(PageSnapshotSchema),
  warnings: z.array(z.string()),
});
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;

export const TargetPolicySchema = z.object({
  allowedOrigins: z.array(z.string().url()).default([]),
  maxPages: z.number().int().min(1).max(50).default(10),
  maxControlsPerPage: z.number().int().min(1).max(200).default(100),
  maxLinksPerPage: z.number().int().min(1).max(200).default(100),
  allowInsecureHttp: z.boolean().default(false),
});
export type TargetPolicy = z.infer<typeof TargetPolicySchema>;

export const HarnessRunInputSchema = z.object({
  targetUrl: z.string().url(),
  projectId: z.string().uuid().optional(),
  goal: z.string().trim().min(5).max(2_000).default(WEB_APP_BASELINE_PRESET),
  policy: TargetPolicySchema.default({
    allowedOrigins: [],
    maxPages: 10,
    maxControlsPerPage: 100,
    maxLinksPerPage: 100,
    allowInsecureHttp: false,
  }),
  artifactsDirectory: z.string().min(1).default("artifacts"),
  headless: z.boolean().default(true),
  storageStatePath: z.string().min(1).optional(),
  /**
   * Opt-in, default false: permits the planner to propose "interact" actions
   * (click/fill/submit) and the workflow to actually execute them, subject
   * to grounding against discovered controls and a destructive-action
   * denylist. When false, interact actions are never planned or executed —
   * discovery/execution stay strictly read-only navigation.
   */
  allowInteractions: z.boolean().default(false),
});
export type HarnessRunInput = z.infer<typeof HarnessRunInputSchema>;

/**
 * Identifies a discovered control an "interact" action should operate on.
 * `kind` maps to a Playwright ARIA role for locating it; `label`/`name`
 * supply the accessible name to match. Grounded against the run's actual
 * AppSnapshot before execution — an ungrounded target is never executed.
 */
export const InteractionTargetSchema = z.object({
  page: z.string(),
  kind: ControlKindSchema,
  label: z.string().optional(),
  name: z.string().optional(),
});
export type InteractionTarget = z.infer<typeof InteractionTargetSchema>;

export const PlannedActionSchema = z.object({
  kind: z.enum(["navigate", "inspect", "authenticate", "interact", "assert", "cleanup"]),
  description: z.string(),
  secretReference: z.string().optional(),
  /** Required for "interact" actions; ignored for every other kind. */
  target: InteractionTargetSchema.optional(),
  /** Text to type (textbox/textarea) or option value to select (select). */
  value: z.string().optional(),
});
export type PlannedAction = z.infer<typeof PlannedActionSchema>;

export const TestPlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string(),
  risk: RiskLevelSchema,
  requiresApproval: z.boolean(),
  actions: z.array(PlannedActionSchema).min(1),
  expectedResult: z.string(),
  cleanup: z.string().optional(),
});
export type TestPlanStep = z.infer<typeof TestPlanStepSchema>;

export const TestPlanSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  createdAt: z.string().datetime(),
  summary: z.string(),
  discoveredRoutes: z.array(z.string()),
  steps: z.array(TestPlanStepSchema).min(1),
  warnings: z.array(z.string()),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

export const NavigationCheckSchema = z.object({
  url: z.string().url(),
  expectedTitle: z.string(),
  observedTitle: z.string().optional(),
  expectedHeading: z.string().optional(),
  observedHeading: z.string().optional(),
  status: z.enum(["passed", "failed"]),
  screenshotPath: z.string().optional(),
  error: z.string().optional(),
});
export type NavigationCheck = z.infer<typeof NavigationCheckSchema>;

export const InteractionCheckSchema = z.object({
  stepId: z.string(),
  description: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  observedUrl: z.string().optional(),
  screenshotPath: z.string().optional(),
  error: z.string().optional(),
});
export type InteractionCheck = z.infer<typeof InteractionCheckSchema>;

export const LighthouseCategoryScoreSchema = z.object({
  id: z.string(),
  title: z.string(),
  score: z.number().min(0).max(1).nullable(),
});
export type LighthouseCategoryScore = z.infer<typeof LighthouseCategoryScoreSchema>;

export const LighthouseFindingSchema = z.object({
  category: z.string(),
  title: z.string(),
  description: z.string(),
  score: z.number().min(0).max(1).nullable(),
});
export type LighthouseFinding = z.infer<typeof LighthouseFindingSchema>;

export const LighthouseAuditResultSchema = z.object({
  url: z.string().url(),
  categories: z.array(LighthouseCategoryScoreSchema),
  findings: z.array(LighthouseFindingSchema),
});
export type LighthouseAuditResult = z.infer<typeof LighthouseAuditResultSchema>;

export const ExecutionResultSchema = z.object({
  runId: z.string().uuid(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  status: z.enum(["passed", "failed"]),
  checks: z.array(NavigationCheckSchema).min(1),
  interactions: z.array(InteractionCheckSchema).default([]),
  lighthouse: LighthouseAuditResultSchema.optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  approver: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2_000).optional(),
  decidedAt: z.string().datetime(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalRequestSchema = z.object({
  type: z.literal("test_plan_approval"),
  runId: z.string().uuid(),
  plan: TestPlanSchema,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const RunRecordSchema = z.object({
  id: z.string().uuid(),
  targetUrl: z.string().url(),
  goal: z.string(),
  status: RunStatusSchema,
  input: HarnessRunInputSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  approval: ApprovalDecisionSchema.optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const KnowledgeCategorySchema = z.enum(["domain_knowledge", "failure", "solution"]);
export type KnowledgeCategory = z.infer<typeof KnowledgeCategorySchema>;

export const KnowledgeDraftEntrySchema = z.object({
  category: KnowledgeCategorySchema,
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  detail: z.string().trim().min(1).max(4_000),
  tags: z.array(z.string().trim().min(1)).max(20).default([]),
});
export type KnowledgeDraftEntry = z.infer<typeof KnowledgeDraftEntrySchema>;

export const KnowledgeDraftSchema = z.object({
  entries: z.array(KnowledgeDraftEntrySchema),
});
export type KnowledgeDraft = z.infer<typeof KnowledgeDraftSchema>;

export const KnowledgeEntrySchema = KnowledgeDraftEntrySchema.extend({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  targetUrl: z.string().url(),
  createdAt: z.string().datetime(),
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
