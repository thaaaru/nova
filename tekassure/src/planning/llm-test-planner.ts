import { randomUUID } from "node:crypto";

import { TestPlanSchema, type TestPlan } from "../domain.js";
import { HeuristicTestPlanner } from "./heuristic-planner.js";
import type { PlanRequest, TestPlanner } from "./heuristic-planner.js";

const DEFAULT_MODEL = "gpt-4o-mini";

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          rationale: { type: "string" },
          risk: { type: "string", enum: ["read_only", "session_change", "state_change"] },
          requiresApproval: { type: "boolean" },
          expectedResult: { type: "string" },
          cleanup: { type: ["string", "null"] },
          actions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: {
                  type: "string",
                  enum: ["navigate", "inspect", "authenticate", "interact", "assert", "cleanup"],
                },
                description: { type: "string" },
                value: { type: ["string", "null"] },
                target: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    page: { type: "string" },
                    kind: {
                      type: "string",
                      enum: [
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
                      ],
                    },
                    label: { type: ["string", "null"] },
                    name: { type: ["string", "null"] },
                  },
                  required: ["page", "kind", "label", "name"],
                },
              },
              required: ["kind", "description", "value", "target"],
            },
          },
        },
        required: ["title", "rationale", "risk", "requiresApproval", "expectedResult", "cleanup", "actions"],
      },
    },
  },
  required: ["summary", "warnings", "steps"],
} as const;

type RawLlmAction = {
  kind: "navigate" | "inspect" | "authenticate" | "interact" | "assert" | "cleanup";
  description: string;
  value: string | null;
  target: { page: string; kind: string; label: string | null; name: string | null } | null;
};

type RawLlmStep = {
  title: string;
  rationale: string;
  risk: "read_only" | "session_change" | "state_change";
  requiresApproval: boolean;
  expectedResult: string;
  cleanup: string | null;
  actions: RawLlmAction[];
};

type RawLlmPlan = { summary: string; warnings: string[]; steps: RawLlmStep[] };

export type PlanWithLlmResult =
  | { ok: true; draft: RawLlmPlan }
  | { ok: false; reason: "no_api_key" | "request_failed" | "invalid_response"; detail?: string };

/**
 * Best-effort, pure function — mirrors summarizeRunForKnowledge's shape and
 * failure handling exactly. A missing key, a failed call, or a response that
 * doesn't parse never throws; the caller (LlmTestPlanner) always has a safe
 * heuristic fallback.
 */
export async function planWithLlm(request: PlanRequest): Promise<PlanWithLlmResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "no_api_key" };
  }

  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const prompt = buildPrompt(request);

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a careful QA planner for an automated web-app testing tool. You reason about a " +
              "discovered app's actual pages and controls to propose a reviewable test plan a human will " +
              "approve or reject before anything runs. Never invent a page, control, label, or name that " +
              "isn't in the provided discovery data — every 'interact' action's target must reference a " +
              "control that literally appears in the discovery data for that exact page. Never propose an " +
              "action that pays, purchases, deletes, cancels, unsubscribes, or otherwise causes an " +
              "irreversible or costly effect. If interactions are disabled for this run, never use the " +
              "'interact' action kind at all — only navigate/inspect/authenticate/assert/cleanup.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "test_plan_draft", strict: true, schema: RESPONSE_SCHEMA },
        },
      }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "request_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "request_failed",
      detail: `HTTP ${response.status}: ${await safeText(response)}`,
    };
  }

  try {
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      return { ok: false, reason: "invalid_response", detail: "No message content in response." };
    }
    const draft = JSON.parse(content) as RawLlmPlan;
    if (!Array.isArray(draft.steps) || draft.steps.length === 0) {
      return { ok: false, reason: "invalid_response", detail: "Model returned no steps." };
    }
    return { ok: true, draft };
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_response",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildPrompt(request: PlanRequest): string {
  const lines: string[] = [
    `Target URL: ${request.snapshot.targetUrl}`,
    `Goal: ${request.goal}`,
    `Interactions ${request.allowInteractions ? "are" : "are NOT"} permitted for this run.`,
    "",
    "Discovered pages:",
  ];
  for (const page of request.snapshot.pages) {
    lines.push(
      `- ${page.path} (${page.url}) — title "${page.title}", headings: ${page.headings.join(", ") || "(none)"}`,
    );
    for (const control of page.controls) {
      lines.push(
        `    control: kind=${control.kind} label=${JSON.stringify(control.label ?? null)} name=${JSON.stringify(control.name ?? null)} disabled=${control.disabled}`,
      );
    }
  }
  if (request.snapshot.warnings.length > 0) {
    lines.push("", `Discovery warnings: ${request.snapshot.warnings.join("; ")}`);
  }
  if (request.knowledge && request.knowledge.length > 0) {
    lines.push("", "Prior knowledge from earlier runs against this target:");
    for (const entry of request.knowledge) {
      lines.push(`- [${entry.category}] ${entry.title}: ${entry.summary}`);
    }
  }
  lines.push(
    "",
    "Propose a test plan as a sequence of reviewable steps. Every 'interact' action's target.page must be " +
      "one of the discovered page paths above, and target.kind/label/name must exactly match a control " +
      "listed for that page.",
  );
  return lines.join("\n");
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "(no body)";
  }
}

/**
 * Replaces HeuristicTestPlanner as the default planner. Falls back to it
 * whenever OPENAI_API_KEY is unset, the API call fails, or the response
 * doesn't parse — identical behavior to today whenever no key is
 * configured, which is why this can be the default without changing
 * anything for existing installs/tests.
 */
export class LlmTestPlanner implements TestPlanner {
  constructor(
    private readonly fallback: TestPlanner = new HeuristicTestPlanner(),
    private readonly generate: typeof planWithLlm = planWithLlm,
  ) {}

  async createPlan(request: PlanRequest): Promise<TestPlan> {
    const result = await this.generate(request);
    if (!result.ok) {
      return this.fallback.createPlan(request);
    }

    try {
      return assemblePlan(request.runId, request.snapshot, result.draft);
    } catch {
      return this.fallback.createPlan(request);
    }
  }
}

function assemblePlan(
  runId: string,
  snapshot: { pages: Array<{ path: string }> },
  draft: RawLlmPlan,
): TestPlan {
  const rawPlan = {
    id: randomUUID(),
    runId,
    createdAt: new Date().toISOString(),
    summary: draft.summary,
    discoveredRoutes: snapshot.pages.map((page) => page.path),
    warnings: draft.warnings,
    steps: draft.steps.map((step) => ({
      id: randomUUID(),
      title: step.title,
      rationale: step.rationale,
      risk: step.risk,
      requiresApproval: step.requiresApproval,
      expectedResult: step.expectedResult,
      cleanup: step.cleanup ?? undefined,
      actions: step.actions.map((action) => ({
        kind: action.kind,
        description: action.description,
        value: action.value ?? undefined,
        target: action.target
          ? {
              page: action.target.page,
              kind: action.target.kind,
              label: action.target.label ?? undefined,
              name: action.target.name ?? undefined,
            }
          : undefined,
      })),
    })),
  };
  // Re-validates every enum/shape the model was asked to respect — an
  // invalid control kind or malformed field throws here, which the caller
  // treats identically to a failed API call and falls back to the
  // heuristic planner instead of trusting unvalidated model output.
  return TestPlanSchema.parse(rawPlan);
}
