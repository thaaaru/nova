import { z } from "zod";

import { RunStatusSchema } from "./run-state.js";
import { VerificationClassificationSchema } from "./execution.js";
import { RiskLevelSchema } from "./plan.js";
import { RecoveryOutcomeSchema } from "./recovery.js";
/**
 * Everything the HTML report renders, derived once from a persisted
 * TestRunState by services/reporting/report-data-adapter.ts. The report
 * generator (services/reporting/html-report-generator.ts) never reads
 * TestRunState directly — it only ever sees this typed, already-redacted
 * view model, so a report can never leak a field nobody reviewed for
 * disclosure.
 */

export const ReportHeaderSchema = z.object({
  runId: z.string(),
  projectId: z.string(),
  tenantId: z.string(),
  environment: z.string(),
  targetBaseUrl: z.string(),
  executionMode: z.enum(["observe", "safe_test", "destructive_test", "mixed"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  totalDurationMs: z.number().int().min(0).optional(),
  terminalOutcome: RunStatusSchema,
  novaVersion: z.string(),
  reportSchemaVersion: z.number().int().positive(),
});
export type ReportHeader = z.infer<typeof ReportHeaderSchema>;

export const ExecutiveSummarySchema = z.object({
  totalTests: z.number().int().min(0),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  flaky: z.number().int().min(0),
  blocked: z.number().int().min(0),
  inconclusive: z.number().int().min(0),
  recoveryAttempts: z.number().int().min(0),
  approvalInterventions: z.number().int().min(0),
  defectCandidates: z.number().int().min(0),
  outcomeStatement: z.string(),
});
export type ExecutiveSummary = z.infer<typeof ExecutiveSummarySchema>;

export const TimelineStageIdSchema = z.enum(["discover", "plan", "approval", "execute", "verify", "report"]);
export type TimelineStageId = z.infer<typeof TimelineStageIdSchema>;

export const TimelineStageSchema = z.object({
  stage: TimelineStageIdSchema,
  status: z.enum(["skipped", "completed", "interrupted", "blocked"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  elapsedMs: z.number().int().min(0).optional(),
  note: z.string().optional(),
});
export type TimelineStage = z.infer<typeof TimelineStageSchema>;

export const ResultDistributionSchema = z.object({
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  flaky: z.number().int().min(0),
  blocked: z.number().int().min(0),
  inconclusive: z.number().int().min(0),
});
export type ResultDistribution = z.infer<typeof ResultDistributionSchema>;

export const CaseDurationSchema = z.object({
  caseId: z.string(),
  title: z.string(),
  durationMs: z.number().int().min(0),
});
export type CaseDuration = z.infer<typeof CaseDurationSchema>;

export const RiskOutcomeCellSchema = z.object({
  riskLevel: RiskLevelSchema,
  classification: VerificationClassificationSchema,
  count: z.number().int().min(0),
});
export type RiskOutcomeCell = z.infer<typeof RiskOutcomeCellSchema>;

export const RecoveryFunnelSchema = z.object({
  failuresDetected: z.number().int().min(0),
  recoveryAttempted: z.number().int().min(0),
  recovered: z.number().int().min(0),
  confirmedDefect: z.number().int().min(0),
  blocked: z.number().int().min(0),
});
export type RecoveryFunnel = z.infer<typeof RecoveryFunnelSchema>;

export const TrendPointSchema = z.object({
  runId: z.string(),
  completedAt: z.string().datetime(),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
});
export type TrendPoint = z.infer<typeof TrendPointSchema>;

export const ReportChartsSchema = z.object({
  distribution: ResultDistributionSchema,
  durationsByCase: z.array(CaseDurationSchema),
  riskOutcomeMatrix: z.array(RiskOutcomeCellSchema),
  recoveryFunnel: RecoveryFunnelSchema,
  trend: z.array(TrendPointSchema).optional(),
});
export type ReportCharts = z.infer<typeof ReportChartsSchema>;

export const ReportRecoveryAttemptSchema = z.object({
  checkpoint: z.string(),
  failureSummary: z.string(),
  action: z.string(),
  attempt: z.number().int().min(1),
  maxAttempts: z.number().int().min(1),
  outcome: RecoveryOutcomeSchema,
});
export type ReportRecoveryAttempt = z.infer<typeof ReportRecoveryAttemptSchema>;

export const ReportAssertionSchema = z.object({
  kind: z.string(),
  expected: z.string(),
  passed: z.boolean(),
  observed: z.string().optional(),
});
export type ReportAssertion = z.infer<typeof ReportAssertionSchema>;

export const ReportEvidenceLinkSchema = z.object({
  kind: z.enum(["screenshot", "trace", "console_log", "report"]),
  label: z.string(),
  path: z.string(),
});
export type ReportEvidenceLink = z.infer<typeof ReportEvidenceLinkSchema>;

export const TestCaseDetailSchema = z.object({
  caseId: z.string(),
  title: z.string(),
  goal: z.string(),
  riskLevel: RiskLevelSchema,
  executionMode: z.enum(["read_only", "state_changing"]),
  classification: VerificationClassificationSchema,
  confidence: z.enum(["high", "medium", "low"]),
  checkpointsReached: z.array(z.string()),
  durationMs: z.number().int().min(0),
  attempts: z.number().int().min(1),
  recoveryAttempts: z.array(ReportRecoveryAttemptSchema),
  assertions: z.array(ReportAssertionSchema),
  evidence: z.array(ReportEvidenceLinkSchema),
  redactedRawResult: z.record(z.string(), z.unknown()),
});
export type TestCaseDetail = z.infer<typeof TestCaseDetailSchema>;

export const DefectClassificationSchema = z.enum([
  "product_defect",
  "flaky_test",
  "test_defect",
  "infrastructure_failure",
]);
export type DefectClassification = z.infer<typeof DefectClassificationSchema>;

export const FindingSchema = z.object({
  caseId: z.string(),
  title: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  classification: DefectClassificationSchema,
  observedBehavior: z.string(),
  expectedBehavior: z.string(),
  reproductionPath: z.array(z.string()),
  affectedCheckpoint: z.string(),
  evidence: z.array(ReportEvidenceLinkSchema),
  recoveryContinuedRun: z.boolean(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const AuditTimelineEntrySchema = z.object({
  timestamp: z.string().datetime(),
  type: z.string(),
  actor: z.string(),
  detail: z.record(z.string(), z.unknown()),
});
export type AuditTimelineEntry = z.infer<typeof AuditTimelineEntrySchema>;

export const GovernanceSchema = z.object({
  scopeManifestVersion: z.string(),
  testPlanId: z.string().optional(),
  testPlanVersion: z.number().int().positive().optional(),
  approverName: z.string().optional(),
  approvalDecision: z.enum(["approved", "rejected"]).optional(),
  approvalDecidedAt: z.string().datetime().optional(),
  /**
   * Full discovery-to-evidence provenance for this run, so a reader can
   * trace any result back to the snapshot it came from, the evidence the
   * identification was grounded in, the model and prompt that produced
   * it, the exact plan that was approved, and the request that ran it.
   */
  traceability: z
    .object({
      discoverySnapshotCapturedAt: z.string().datetime().optional(),
      discoveredPageCount: z.number().int().min(0).optional(),
      applicationName: z.string().optional(),
      identificationSource: z.string().optional(),
      identificationConfidence: z.number().min(0).max(1).optional(),
      identificationVersion: z.number().int().positive().optional(),
      evidenceHash: z.string().optional(),
      evidenceItemCount: z.number().int().min(0).optional(),
      llmProvider: z.string().optional(),
      llmModel: z.string().optional(),
      promptVersion: z.string().optional(),
      planHash: z.string().optional(),
      approvalId: z.string().optional(),
      approvalSnapshotHash: z.string().optional(),
      executionRequestId: z.string().optional(),
      executionIdempotencyKey: z.string().optional(),
      policyVersion: z.string().optional(),
    })
    .optional(),
  executionPolicy: z.string(),
  runtimeVersions: z.record(z.string(), z.string()),
  stateTransitions: z.array(
    z.object({ from: z.string().optional(), to: z.string(), at: z.string().datetime() }),
  ),
  redactedAuditTimeline: z.array(AuditTimelineEntrySchema),
});
export type Governance = z.infer<typeof GovernanceSchema>;

export const ReportFooterSchema = z.object({
  generatedAt: z.string().datetime(),
  reportVersion: z.string(),
  integrityHash: z.string().optional(),
});
export type ReportFooter = z.infer<typeof ReportFooterSchema>;

export const ReportDataSchema = z.object({
  header: ReportHeaderSchema,
  executiveSummary: ExecutiveSummarySchema,
  timeline: z.array(TimelineStageSchema),
  charts: ReportChartsSchema,
  testCases: z.array(TestCaseDetailSchema),
  findings: z.array(FindingSchema),
  governance: GovernanceSchema,
  footer: ReportFooterSchema,
});
export type ReportData = z.infer<typeof ReportDataSchema>;
