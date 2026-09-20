import { KnowledgeDraftSchema, type KnowledgeDraft } from "../domain.js";

export type RunKnowledgeContext = {
  targetUrl: string;
  goal: string;
  outcome: "completed" | "failed";
  discoveredRoutes?: string[];
  discoveryWarnings?: string[];
  planSummary?: string;
  checks?: Array<{ url: string; status: "passed" | "failed"; error?: string }>;
  errorMessage?: string;
};

export type SummarizeResult =
  | { ok: true; draft: KnowledgeDraft }
  | { ok: false; reason: "no_api_key" | "request_failed" | "invalid_response"; detail?: string };

const DEFAULT_MODEL = "gpt-4o-mini";

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string", enum: ["domain_knowledge", "failure", "solution"] },
          title: { type: "string" },
          summary: { type: "string" },
          detail: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["category", "title", "summary", "detail", "tags"],
      },
    },
  },
  required: ["entries"],
} as const;

/**
 * Best-effort: a missing key or a failed API call never blocks or fails the
 * run that triggered it. Called directly via fetch — no SDK dependency, this
 * is a single JSON request/response.
 */
export async function summarizeRunForKnowledge(context: RunKnowledgeContext): Promise<SummarizeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "no_api_key" };
  }

  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const prompt = buildPrompt(context);

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
              "You extract reusable testing knowledge from a single automated web-app scan run. " +
              "Only report facts directly supported by the provided run data. Produce zero entries if " +
              "there is nothing worth remembering.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "knowledge_draft", strict: true, schema: RESPONSE_SCHEMA },
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
    const draft = KnowledgeDraftSchema.parse(JSON.parse(content));
    return { ok: true, draft };
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_response",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildPrompt(context: RunKnowledgeContext): string {
  const lines: string[] = [
    `Target URL: ${context.targetUrl}`,
    `Goal: ${context.goal}`,
    `Outcome: ${context.outcome}`,
  ];
  if (context.discoveredRoutes && context.discoveredRoutes.length > 0) {
    lines.push(`Discovered routes: ${context.discoveredRoutes.join(", ")}`);
  }
  if (context.discoveryWarnings && context.discoveryWarnings.length > 0) {
    lines.push(`Discovery warnings: ${context.discoveryWarnings.join("; ")}`);
  }
  if (context.planSummary) {
    lines.push(`Plan summary: ${context.planSummary}`);
  }
  if (context.checks && context.checks.length > 0) {
    lines.push("Checks:");
    for (const check of context.checks) {
      lines.push(`- ${check.url}: ${check.status}${check.error ? ` (${check.error})` : ""}`);
    }
  }
  if (context.errorMessage) {
    lines.push(`Run error: ${context.errorMessage}`);
  }
  lines.push(
    "Summarize any durable domain knowledge about this application, any failure worth remembering, " +
      "and any known solution/fix implied by the data above. Return an empty entries array if nothing " +
      "is worth keeping.",
  );
  return lines.join("\n");
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}
