import { randomUUID } from "node:crypto";

import type { KnowledgeEntry } from "../domain.js";
import type { KnowledgeRepository } from "../storage/knowledge-repository.js";
import { summarizeRunForKnowledge, type RunKnowledgeContext } from "./openai-summarizer.js";

export type CaptureKnowledgeResult =
  | { captured: number }
  | { captured: 0; skippedReason: "no_api_key" | "request_failed" | "invalid_response"; detail?: string };

/**
 * Best-effort, non-blocking: called after every terminal run state
 * (completed or failed). A missing OPENAI_API_KEY or a failed API call
 * never affects the run itself — only whether a knowledge entry gets
 * recorded for it.
 */
export async function captureKnowledge(
  repository: KnowledgeRepository,
  runId: string,
  context: RunKnowledgeContext,
  summarize: typeof summarizeRunForKnowledge = summarizeRunForKnowledge,
): Promise<CaptureKnowledgeResult> {
  const result = await summarize(context);
  if (!result.ok) {
    return { captured: 0, skippedReason: result.reason, detail: result.detail };
  }

  if (result.draft.entries.length === 0) {
    return { captured: 0 };
  }

  const now = new Date().toISOString();
  const entries: KnowledgeEntry[] = result.draft.entries.map((entry) => ({
    ...entry,
    id: randomUUID(),
    runId,
    targetUrl: context.targetUrl,
    createdAt: now,
  }));
  repository.addEntries(entries);
  return { captured: entries.length };
}
