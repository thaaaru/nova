import { z } from "zod";

/**
 * One atomic, deterministically executable action. No free text a model
 * could reinterpret at execution time — target is always a concrete
 * selector/role/name pair, resolved by Playwright, not by an LLM.
 */
export const TestStepSchema = z.object({
  kind: z.enum(["navigate", "click", "fill", "select", "check", "waitForSelector", "waitForUrl"]),
  url: z.string().url().optional(),
  selector: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  timeoutMs: z.number().int().positive().default(10_000),
});
export type TestStep = z.infer<typeof TestStepSchema>;

export const AssertionSchema = z.object({
  kind: z.enum(["urlEquals", "urlContains", "titleContains", "textVisible", "elementVisible", "statusCode"]),
  target: z.string().optional(),
  expected: z.string(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(1),
  backoffMs: z.number().int().min(0).default(0),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const ExecutionModeSchema = z.enum(["read_only", "state_changing"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const TestCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  preconditions: z.array(z.string()).default([]),
  steps: z.array(TestStepSchema).min(1),
  assertions: z.array(AssertionSchema).min(1),
  allowedDomains: z.array(z.string().min(1)).min(1),
  executionMode: ExecutionModeSchema,
  riskLevel: RiskLevelSchema,
  timeoutMs: z.number().int().positive().default(60_000),
  retryPolicy: RetryPolicySchema.default({ maxAttempts: 1, backoffMs: 0 }),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const TestPlanSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().default(1),
  objective: z.string().min(1),
  targetManifestId: z.string().min(1),
  createdAt: z.string().datetime(),
  cases: z.array(TestCaseSchema).min(1),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

export const ApprovalSchema = z.object({
  planId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  reviewer: z.string().min(1),
  decidedAt: z.string().datetime(),
  note: z.string().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
