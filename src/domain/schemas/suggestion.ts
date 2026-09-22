import { z } from "zod";

import { RiskLevelSchema, TestCaseSchema } from "./plan.js";

/**
 * A suggested test case: the executable spec plus everything a reviewer
 * needs to judge it. The executable half is a plain `TestCase` — the same
 * deterministic shape Playwright already runs — so a suggestion can never
 * carry an instruction the executor would have to interpret. Everything
 * else here is review metadata: where it came from, what it will touch,
 * and which evidence supports it.
 *
 * A suggestion is a *candidate*. Nothing in this file is approved,
 * authorized, or runnable until it has passed deterministic validation
 * and a human has selected it on the approval page.
 */

export const SuggestionSourceSchema = z.enum(["rule", "llm", "combined"]);
export type SuggestionSource = z.infer<typeof SuggestionSourceSchema>;

export const TestTypeSchema = z.enum(["smoke", "navigation", "functional", "form", "regression", "api"]);
export type TestType = z.infer<typeof TestTypeSchema>;

/**
 * What running the case does to the application's state. Derived in code
 * from the case's own executionMode and steps — a model never gets to
 * downgrade a mutation to "none".
 */
export const SideEffectClassSchema = z.enum([
  "none",
  "creates_data",
  "modifies_data",
  "deletes_data",
  "irreversible",
]);
export type SideEffectClass = z.infer<typeof SideEffectClassSchema>;

export const ApprovalLevelSchema = z.enum(["standard", "elevated"]);
export type ApprovalLevel = z.infer<typeof ApprovalLevelSchema>;

export const SuggestedTestCaseSchema = z.object({
  /** Stable within a plan; assigned by code, never accepted from a model. */
  id: z.string().min(1),
  testCase: TestCaseSchema,
  area: z.string().min(1),
  journey: z.string().min(1),
  persona: z.string().min(1).nullable().default(null),
  testType: TestTypeSchema,
  priority: RiskLevelSchema,
  expectedResult: z.string().min(1),
  fixtureRefs: z.array(z.string().min(1)).default([]),
  sideEffect: SideEffectClassSchema,
  evidenceRefs: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
  source: SuggestionSourceSchema,
  requiredApprovalLevel: ApprovalLevelSchema,
});
export type SuggestedTestCase = z.infer<typeof SuggestedTestCaseSchema>;

export const SuggestionRejectionSchema = z.object({
  candidateId: z.string().min(1),
  title: z.string().min(1),
  check: z.enum([
    "scope",
    "target",
    "route_existence",
    "persona_existence",
    "fixture_availability",
    "policy",
    "duplicate",
    "side_effect_classification",
    "evidence_traceability",
    "executability",
  ]),
  reason: z.string().min(1),
});
export type SuggestionRejection = z.infer<typeof SuggestionRejectionSchema>;

export const SuggestedTestPlanSchema = z.object({
  planId: z.string().min(1),
  accepted: z.array(SuggestedTestCaseSchema).default([]),
  rejected: z.array(SuggestionRejectionSchema).default([]),
});
export type SuggestedTestPlan = z.infer<typeof SuggestedTestPlanSchema>;
