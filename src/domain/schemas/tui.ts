import { z } from "zod";

import { RunStatusSchema } from "./run-state.js";
import { TimelineStageIdSchema } from "./reporting.js";

/**
 * View-model types for the terminal UI. The TUI presentation layer
 * (src/tui/**) only ever consumes these — never TestRunState directly —
 * so the same redaction and verbosity rules apply whether a value reaches
 * the operator through the CLI, the MCP tool results, or the TUI.
 */

export const VerbosityLevelSchema = z.enum(["executive", "standard", "diagnostic"]);
export type VerbosityLevel = z.infer<typeof VerbosityLevelSchema>;

export const RunEventLevelSchema = z.enum(["info", "warning", "error", "recovery", "approval"]);
export type RunEventLevel = z.infer<typeof RunEventLevelSchema>;

/**
 * One entry in the live event feed. `minVerbosity` is the lowest verbosity
 * level at which this event is shown — e.g. a locator/tool-call trace is
 * `diagnostic`-only, a policy block or approval request is always shown
 * (`executive`). Detail values must already be redacted by the producer;
 * the TUI does not re-inspect them for secrets.
 */
export const RunEventSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),
  stage: TimelineStageIdSchema,
  level: RunEventLevelSchema,
  minVerbosity: VerbosityLevelSchema,
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const NextActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  description: z.string().optional(),
});
export type NextAction = z.infer<typeof NextActionSchema>;

export const TestCountsSchema = z.object({
  planned: z.number().int().min(0),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  flaky: z.number().int().min(0),
  blocked: z.number().int().min(0),
  inconclusive: z.number().int().min(0),
  pending: z.number().int().min(0),
});
export type TestCounts = z.infer<typeof TestCountsSchema>;

export const RecoveryStateSchema = z.object({
  active: z.boolean(),
  caseId: z.string().optional(),
  checkpoint: z.string().optional(),
  failureSummary: z.string().optional(),
  evidenceSummary: z.string().optional(),
  action: z.string().optional(),
  attempt: z.number().int().min(1).optional(),
  maxAttempts: z.number().int().min(1).optional(),
});
export type RecoveryState = z.infer<typeof RecoveryStateSchema>;

/**
 * Everything the Home/Live-Execution screens render, derived once per
 * refresh from a persisted TestRunState by tui/services (see
 * report-data-adapter.ts's sibling for the TUI, which lives alongside the
 * reporting adapter but produces this narrower, faster-to-compute shape).
 */
export const RunViewModelSchema = z.object({
  runId: z.string().optional(),
  projectId: z.string().optional(),
  tenantId: z.string().optional(),
  environment: z.string().optional(),
  targetBaseUrl: z.string().optional(),
  runExecutionMode: z.enum(["observe", "safe_test", "destructive_test"]).optional(),
  status: RunStatusSchema.optional(),
  currentStage: TimelineStageIdSchema.optional(),
  scopeSummary: z.string().optional(),
  policyModeLabel: z.string(),
  testCounts: TestCountsSchema,
  lastEvent: RunEventSchema.optional(),
  blockers: z.array(z.string()),
  nextActions: z.array(NextActionSchema),
  recovery: RecoveryStateSchema,
  elapsedMs: z.number().int().min(0).optional(),
});
export type RunViewModel = z.infer<typeof RunViewModelSchema>;

export const GuidedSetupInputSchema = z.object({
  projectName: z.string().min(1),
  environment: z.string().min(1),
  targetUrl: z.string().url(),
  allowedDomains: z.array(z.string().min(1)).min(1),
  runExecutionMode: z.enum(["observe", "safe_test", "destructive_test"]),
  objective: z.string().min(1),
});
export type GuidedSetupInput = z.infer<typeof GuidedSetupInputSchema>;

export const CommandParseResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), name: z.string(), args: z.record(z.string(), z.string()) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CommandParseResult = z.infer<typeof CommandParseResultSchema>;
