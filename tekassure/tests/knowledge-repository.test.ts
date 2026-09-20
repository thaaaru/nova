import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { KnowledgeEntry } from "../src/domain.js";
import { KnowledgeRepository } from "../src/storage/knowledge-repository.js";

describe("KnowledgeRepository", () => {
  const resources: Array<{ repository: KnowledgeRepository; directory: string }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      resource.repository.close();
      await rm(resource.directory, { recursive: true, force: true });
    }
  });

  function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
    return {
      id: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000002",
      targetUrl: "https://example.com",
      category: "domain_knowledge",
      title: "Public marketing site",
      summary: "The homepage exposes a single public route with no authentication.",
      detail: "Discovery found one page at / with title Example Domain and no interactive controls.",
      tags: ["public", "marketing"],
      createdAt: "2026-09-17T00:00:00.000Z",
      ...overrides,
    };
  }

  async function open(): Promise<KnowledgeRepository> {
    const directory = await mkdtemp(join(tmpdir(), "nova-knowledge-repository-"));
    const repository = new KnowledgeRepository(join(directory, "knowledge.sqlite"));
    resources.push({ repository, directory });
    return repository;
  }

  it("persists entries and lists them most-recent-first", async () => {
    const repository = await open();
    const older = entry({
      id: "00000000-0000-4000-8000-000000000010",
      createdAt: "2026-09-16T00:00:00.000Z",
    });
    const newer = entry({
      id: "00000000-0000-4000-8000-000000000011",
      createdAt: "2026-09-17T00:00:00.000Z",
    });

    repository.addEntries([older, newer]);

    expect(repository.list()).toEqual([newer, older]);
    expect(repository.getEntry(newer.id)).toEqual(newer);
  });

  it("filters by category and target URL", async () => {
    const repository = await open();
    const failure = entry({
      id: "00000000-0000-4000-8000-000000000020",
      category: "failure",
      targetUrl: "https://a.example.com",
    });
    const domain = entry({
      id: "00000000-0000-4000-8000-000000000021",
      category: "domain_knowledge",
      targetUrl: "https://b.example.com",
    });
    repository.addEntries([failure, domain]);

    expect(repository.list({ category: "failure" })).toEqual([failure]);
    expect(repository.list({ targetUrl: "https://b.example.com" })).toEqual([domain]);
    expect(repository.list({ category: "solution" })).toEqual([]);
  });

  it("searches across title, summary, detail, and tags", async () => {
    const repository = await open();
    const match = entry({
      id: "00000000-0000-4000-8000-000000000030",
      title: "Checkout requires MFA",
      tags: ["checkout", "mfa"],
    });
    const nonMatch = entry({ id: "00000000-0000-4000-8000-000000000031", title: "Unrelated entry" });
    repository.addEntries([match, nonMatch]);

    expect(repository.search("mfa")).toEqual([match]);
    expect(repository.search("checkout")).toEqual([match]);
    expect(repository.search("nonexistent-term")).toEqual([]);
  });

  it("fails clearly for an unknown entry", async () => {
    const repository = await open();
    expect(() => repository.getEntry("00000000-0000-4000-8000-000000000099")).toThrow(
      "Knowledge entry not found: 00000000-0000-4000-8000-000000000099",
    );
  });
});
