import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { captureKnowledge } from "../src/knowledge/learning-agent.js";
import type { SummarizeResult } from "../src/knowledge/openai-summarizer.js";
import { KnowledgeRepository } from "../src/storage/knowledge-repository.js";

describe("captureKnowledge", () => {
  const resources: Array<{ repository: KnowledgeRepository; directory: string }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      resource.repository.close();
      await rm(resource.directory, { recursive: true, force: true });
    }
  });

  async function open(): Promise<KnowledgeRepository> {
    const directory = await mkdtemp(join(tmpdir(), "nova-learning-agent-"));
    const repository = new KnowledgeRepository(join(directory, "knowledge.sqlite"));
    resources.push({ repository, directory });
    return repository;
  }

  const runId = "00000000-0000-4000-8000-000000000001";
  const context = {
    targetUrl: "https://example.com",
    goal: "Check the homepage.",
    outcome: "completed" as const,
  };

  it("stores every drafted entry against the run and target URL", async () => {
    const repository = await open();
    const summarize = async (): Promise<SummarizeResult> => ({
      ok: true,
      draft: {
        entries: [
          {
            category: "domain_knowledge",
            title: "Single public route",
            summary: "The app exposes exactly one public page.",
            detail: "Discovery found only / with no forms.",
            tags: ["public"],
          },
        ],
      },
    });

    const result = await captureKnowledge(repository, runId, context, summarize);

    expect(result).toEqual({ captured: 1 });
    const stored = repository.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      runId,
      targetUrl: "https://example.com",
      category: "domain_knowledge",
      title: "Single public route",
    });
  });

  it("stores nothing and reports the reason when no API key is configured", async () => {
    const repository = await open();
    const summarize = async (): Promise<SummarizeResult> => ({ ok: false, reason: "no_api_key" });

    const result = await captureKnowledge(repository, runId, context, summarize);

    expect(result).toEqual({ captured: 0, skippedReason: "no_api_key" });
    expect(repository.list()).toEqual([]);
  });

  it("stores nothing when the model reports no durable knowledge", async () => {
    const repository = await open();
    const summarize = async (): Promise<SummarizeResult> => ({ ok: true, draft: { entries: [] } });

    const result = await captureKnowledge(repository, runId, context, summarize);

    expect(result).toEqual({ captured: 0 });
    expect(repository.list()).toEqual([]);
  });
});
