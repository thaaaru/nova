import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import type { DiscoverySnapshot, TargetManifest, TestCase } from "../../domain/index.js";
import { TestCaseSchema } from "../../domain/index.js";

/**
 * What the orchestrator asks the model to produce: the same TestCase shape
 * the deterministic template planner builds, minus `id` (assigned by code
 * after validation, never trusted from the model) and minus `allowedDomains`
 * (the model is never given the choice — code stamps the manifest's own
 * allowedDomains onto every case it proposes, see createDeepSeekPlanGenerator).
 *
 * This is the whole guardrail: the model can only ever propose steps,
 * assertions, and risk metadata shaped like a TestCase. It cannot invent a
 * new field, escalate execution mode past what checkCaseScope/
 * checkExecutionAllowed independently re-check later, or grant itself a
 * domain the manifest didn't already approve.
 */
const ProposedTestCaseSchema = TestCaseSchema.omit({ id: true, allowedDomains: true });
const ProposedPlanSchema = z.object({
  cases: z.array(ProposedTestCaseSchema).min(1).max(10),
});

export type GenerateCasesInput = {
  objective: string;
  manifest: TargetManifest;
  snapshot: DiscoverySnapshot;
};

export type PlanGenerator = (input: GenerateCasesInput) => Promise<TestCase[]>;

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * The orchestrator's one LLM integration point, backed by DeepSeek's
 * OpenAI-compatible chat completions API (same request/response shape as
 * OpenAI, just a different base URL and model — @langchain/openai's
 * ChatOpenAI talks to it directly via `configuration.baseURL`, no separate
 * SDK needed). Everything upstream and downstream of this call is
 * deterministic code (see plan-templates.ts, scope-policy.ts): the model
 * only ever *proposes* a plan shaped like the domain schema; createPlanNode
 * re-validates every case against checkCaseScope before anything is stored
 * or shown for approval, exactly like a human-authored plan would be. The
 * model is never told it can change allowedDomains — that's stamped by code
 * after the call returns.
 */
export function createDeepSeekPlanGenerator(options: { apiKey: string; model?: string }): PlanGenerator {
  const chat = new ChatOpenAI({
    apiKey: options.apiKey,
    model: options.model ?? "deepseek-chat",
    temperature: 0,
    configuration: { baseURL: DEEPSEEK_BASE_URL },
  });
  const structured = chat.withStructuredOutput(ProposedPlanSchema, { name: "propose_test_plan" });

  return async ({ objective, manifest, snapshot }) => {
    const prompt = buildPrompt(objective, manifest, snapshot);
    const result = (await structured.invoke(prompt)) as z.infer<typeof ProposedPlanSchema>;

    return result.cases.map((proposedCase, index) => ({
      ...proposedCase,
      id: `llm-${index + 1}`,
      // Stamped by code, never accepted from the model's own output —
      // checkCaseScope re-derives this same restriction independently, but
      // the model is never even given the surface to propose otherwise.
      allowedDomains: manifest.allowedDomains,
    }));
  };
}

function buildPrompt(objective: string, manifest: TargetManifest, snapshot: DiscoverySnapshot): string {
  const pages = snapshot.pages.map((page) => ({
    url: page.url,
    title: page.title,
    forms: page.forms.map((form) => ({
      selector: form.selector,
      fields: form.fields.map((field) => ({ name: field.name, type: field.type })),
    })),
    buttons: page.buttons.map((button) => button.text),
  }));

  return [
    "You are proposing a test plan for a governed web test-automation tool.",
    "You may ONLY reference pages, forms, and buttons literally present in the discovery snapshot below.",
    "Never invent a URL, selector, or flow that was not observed.",
    "Every step's selector must be derived from a form/button in the snapshot.",
    `Objective: ${objective}`,
    `Target: ${manifest.baseUrl} (environment: ${manifest.environment}, mode: ${manifest.runExecutionMode})`,
    `Discovered pages:\n${JSON.stringify(pages, null, 2)}`,
    "Propose 1-10 test cases as steps/assertions/risk metadata matching the required schema.",
    "Prefer read_only cases for pages with no forms, and state_changing cases only for real discovered forms.",
  ].join("\n\n");
}
