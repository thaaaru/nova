import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AppSnapshot, ExecutionResult } from "../src/domain.js";
import type { AppDiscoverer, DiscoveryRequest } from "../src/discovery/contracts.js";
import type {
  NavigationExecutionInput,
  NavigationExecutor,
} from "../src/execution/public-navigation-executor.js";
import type { SummarizeResult } from "../src/knowledge/openai-summarizer.js";
import { KnowledgeRepository } from "../src/storage/knowledge-repository.js";
import { RunRepository } from "../src/storage/run-repository.js";
import { HarnessWorkflow } from "../src/workflow/harness-workflow.js";
import { WEB_APP_BASELINE_GOAL, WEB_APP_BASELINE_PRESET } from "../src/goal-presets.js";

class FakeDiscoverer implements AppDiscoverer {
  requests: DiscoveryRequest[] = [];

  async discover(request: DiscoveryRequest): Promise<AppSnapshot> {
    this.requests.push(request);
    return {
      id: randomUUID(),
      targetUrl: request.targetUrl,
      discoveredAt: new Date().toISOString(),
      warnings: [],
      pages: [
        {
          url: request.targetUrl,
          path: "/",
          title: "Example application",
          headings: ["Welcome"],
          controls: [
            { kind: "textbox", label: "Email", disabled: false, inputType: "email" },
            { kind: "textbox", label: "Password", disabled: false, inputType: "password" },
          ],
          links: [],
          consoleErrors: [],
          pageErrors: [],
          fingerprint: "fixture-fingerprint",
        },
      ],
    };
  }
}

class FakeNavigationExecutor implements NavigationExecutor {
  calls: NavigationExecutionInput[] = [];

  async execute(input: NavigationExecutionInput): Promise<ExecutionResult> {
    this.calls.push(input);
    const timestamp = new Date().toISOString();
    return {
      runId: input.runId,
      startedAt: timestamp,
      completedAt: timestamp,
      status: "passed",
      checks: input.snapshot.pages.map((page) => ({
        url: page.url,
        expectedTitle: page.title,
        observedTitle: page.title,
        expectedHeading: page.headings.at(0),
        observedHeading: page.headings.at(0),
        status: "passed",
      })),
      interactions: [],
    };
  }
}

class ThrowOnceNavigationExecutor implements NavigationExecutor {
  calls = 0;

  async execute(input: NavigationExecutionInput): Promise<ExecutionResult> {
    this.calls += 1;
    if (this.calls === 1) {
      throw new Error("browser launch failed");
    }
    const timestamp = new Date().toISOString();
    return {
      runId: input.runId,
      startedAt: timestamp,
      completedAt: timestamp,
      status: "passed",
      checks: input.snapshot.pages.map((page) => ({
        url: page.url,
        expectedTitle: page.title,
        observedTitle: page.title,
        expectedHeading: page.headings.at(0),
        observedHeading: page.headings.at(0),
        status: "passed",
      })),
      interactions: [],
    };
  }
}

class FailingDiscoverer implements AppDiscoverer {
  async discover(): Promise<AppSnapshot> {
    throw new Error("target unreachable");
  }
}

describe("HarnessWorkflow", () => {
  const resources: Array<{ workflow: HarnessWorkflow; repository: RunRepository; directory: string }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      resource.workflow.close();
      resource.repository.close();
      await rm(resource.directory, { recursive: true, force: true });
    }
  });

  it("persists discovery and pauses until the plan is explicitly approved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-workflow-"));
    const databasePath = join(directory, "harness.sqlite");
    const repository = new RunRepository(databasePath);
    const discoverer = new FakeDiscoverer();
    const executor = new FakeNavigationExecutor();
    const workflow = new HarnessWorkflow({
      repository,
      discoverer,
      executor,
      lighthouseAuditor: async () => undefined,
    });
    resources.push({ workflow, repository, directory });

    const pending = await workflow.start({
      targetUrl: "https://staging.example.test",
      goal: WEB_APP_BASELINE_PRESET,
      artifactsDirectory: join(directory, "artifacts"),
      headless: false,
      policy: {
        allowedOrigins: [],
        maxPages: 5,
        maxControlsPerPage: 20,
        maxLinksPerPage: 20,
        allowInsecureHttp: false,
      },
    });

    expect(pending.status).toBe("awaiting_approval");
    expect(repository.getRun(pending.runId).goal).toBe(WEB_APP_BASELINE_GOAL);
    expect(pending.plan?.steps.some((step) => step.id === "verify-public-route-baseline")).toBe(true);
    expect(pending.plan?.steps.some((step) => step.requiresApproval)).toBe(true);
    expect(discoverer.requests).toHaveLength(1);
    expect(discoverer.requests[0]?.headless).toBe(false);
    expect(repository.getSnapshot(pending.runId)?.pages).toHaveLength(1);

    const approved = await workflow.approve(pending.runId, "test-operator", "The test scope is safe.");
    expect(approved.status).toBe("ready_to_execute");
    expect(repository.getRun(pending.runId).approval?.decision).toBe("approved");
    expect(repository.listEvents(pending.runId).map((event) => event.type)).toContain("plan_approved");

    const executed = await workflow.execute(pending.runId);
    expect(executed.status).toBe("passed");
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.headless).toBe(false);
    expect(repository.getExecution(pending.runId)?.status).toBe("passed");
    expect(repository.listEvents(pending.runId).map((event) => event.type)).toContain("execution_completed");
  });

  it("allows re-execution after the executor throws without ever saving an execution row", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-workflow-"));
    const databasePath = join(directory, "harness.sqlite");
    const repository = new RunRepository(databasePath);
    const discoverer = new FakeDiscoverer();
    const executor = new ThrowOnceNavigationExecutor();
    const workflow = new HarnessWorkflow({
      repository,
      discoverer,
      executor,
      lighthouseAuditor: async () => undefined,
    });
    resources.push({ workflow, repository, directory });

    const pending = await workflow.start({
      targetUrl: "https://staging.example.test",
      goal: WEB_APP_BASELINE_PRESET,
      artifactsDirectory: join(directory, "artifacts"),
      headless: false,
      policy: {
        allowedOrigins: [],
        maxPages: 5,
        maxControlsPerPage: 20,
        maxLinksPerPage: 20,
        allowInsecureHttp: false,
      },
    });
    await workflow.approve(pending.runId, "test-operator", "The test scope is safe.");

    await expect(workflow.execute(pending.runId)).rejects.toThrow("browser launch failed");
    expect(repository.getRun(pending.runId).status).toBe("failed");
    expect(repository.getExecution(pending.runId)).toBeUndefined();

    const executed = await workflow.execute(pending.runId);
    expect(executed.status).toBe("passed");
    expect(executor.calls).toBe(2);
  });

  it("rejects a start() call whose storage state file does not exist, and threads it through when valid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-workflow-auth-"));
    const databasePath = join(directory, "harness.sqlite");
    const repository = new RunRepository(databasePath);
    const discoverer = new FakeDiscoverer();
    const executor = new FakeNavigationExecutor();
    const workflow = new HarnessWorkflow({
      repository,
      discoverer,
      executor,
      lighthouseAuditor: async () => undefined,
    });
    resources.push({ workflow, repository, directory });

    const missingPath = join(directory, "missing-storage-state.json");
    await expect(
      workflow.start({
        targetUrl: "https://staging.example.test",
        goal: WEB_APP_BASELINE_PRESET,
        artifactsDirectory: join(directory, "artifacts"),
        storageStatePath: missingPath,
        policy: {
          allowedOrigins: [],
          maxPages: 5,
          maxControlsPerPage: 20,
          maxLinksPerPage: 20,
          allowInsecureHttp: false,
        },
      }),
    ).rejects.toThrow(`Storage state file not found: ${missingPath}`);

    const storageStatePath = join(directory, "storage-state.json");
    await writeFile(storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
    await workflow.start({
      targetUrl: "https://staging.example.test",
      goal: WEB_APP_BASELINE_PRESET,
      artifactsDirectory: join(directory, "artifacts"),
      storageStatePath,
      policy: {
        allowedOrigins: [],
        maxPages: 5,
        maxControlsPerPage: 20,
        maxLinksPerPage: 20,
        allowInsecureHttp: false,
      },
    });

    expect(discoverer.requests.at(-1)?.storageStatePath).toBe(storageStatePath);
  });

  it("captures a knowledge entry after a successful execution when a knowledge repository is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-workflow-knowledge-"));
    const repository = new RunRepository(join(directory, "harness.sqlite"));
    const knowledgeRepository = new KnowledgeRepository(join(directory, "knowledge.sqlite"));
    const discoverer = new FakeDiscoverer();
    const executor = new FakeNavigationExecutor();
    const summarizeCalls: Array<{ outcome: string; targetUrl: string }> = [];
    const summarizeRun = async (context: {
      outcome: "completed" | "failed";
      targetUrl: string;
    }): Promise<SummarizeResult> => {
      summarizeCalls.push({ outcome: context.outcome, targetUrl: context.targetUrl });
      return {
        ok: true,
        draft: {
          entries: [
            {
              category: "domain_knowledge",
              title: "Single public route",
              summary: "The app exposes exactly one page with no forms.",
              detail: "Discovery and execution both observed only the root route.",
              tags: [],
            },
          ],
        },
      };
    };
    const workflow = new HarnessWorkflow({
      repository,
      discoverer,
      executor,
      knowledgeRepository,
      summarizeRun,
      lighthouseAuditor: async () => undefined,
    });
    resources.push({ workflow, repository, directory });

    const pending = await workflow.start({
      targetUrl: "https://staging.example.test",
      goal: WEB_APP_BASELINE_PRESET,
      artifactsDirectory: join(directory, "artifacts"),
      policy: {
        allowedOrigins: [],
        maxPages: 5,
        maxControlsPerPage: 20,
        maxLinksPerPage: 20,
        allowInsecureHttp: false,
      },
    });
    await workflow.approve(pending.runId, "test-operator", "The test scope is safe.");
    await workflow.execute(pending.runId);

    expect(summarizeCalls).toEqual([{ outcome: "completed", targetUrl: "https://staging.example.test" }]);
    const entries = knowledgeRepository.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: pending.runId, category: "domain_knowledge" });
    expect(repository.listEvents(pending.runId).map((event) => event.type)).toContain("knowledge_captured");

    knowledgeRepository.close();
  });

  it("captures a failure knowledge entry, and never blocks the run, when discovery throws", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-workflow-knowledge-failure-"));
    const repository = new RunRepository(join(directory, "harness.sqlite"));
    const knowledgeRepository = new KnowledgeRepository(join(directory, "knowledge.sqlite"));
    const summarizeRun = async (): Promise<SummarizeResult> => ({
      ok: true,
      draft: {
        entries: [
          {
            category: "failure",
            title: "Target unreachable",
            summary: "Discovery could not reach the target after retrying.",
            detail: "Both discovery attempts failed with: target unreachable",
            tags: ["network"],
          },
        ],
      },
    });
    const workflow = new HarnessWorkflow({
      repository,
      discoverer: new FailingDiscoverer(),
      knowledgeRepository,
      summarizeRun,
    });
    resources.push({ workflow, repository, directory });

    await expect(
      workflow.start({
        targetUrl: "https://staging.example.test",
        goal: WEB_APP_BASELINE_PRESET,
        artifactsDirectory: join(directory, "artifacts"),
        policy: {
          allowedOrigins: [],
          maxPages: 5,
          maxControlsPerPage: 20,
          maxLinksPerPage: 20,
          allowInsecureHttp: false,
        },
      }),
    ).rejects.toThrow("target unreachable");

    const entries = knowledgeRepository.list({ category: "failure" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ category: "failure", title: "Target unreachable" });

    knowledgeRepository.close();
  });

  it("never fails the run when knowledge capture itself throws", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-workflow-knowledge-error-"));
    const repository = new RunRepository(join(directory, "harness.sqlite"));
    const knowledgeRepository = new KnowledgeRepository(join(directory, "knowledge.sqlite"));
    const discoverer = new FakeDiscoverer();
    const executor = new FakeNavigationExecutor();
    const summarizeRun = async (): Promise<SummarizeResult> => {
      throw new Error("network is down");
    };
    const workflow = new HarnessWorkflow({
      repository,
      discoverer,
      executor,
      knowledgeRepository,
      summarizeRun,
      lighthouseAuditor: async () => undefined,
    });
    resources.push({ workflow, repository, directory });

    const pending = await workflow.start({
      targetUrl: "https://staging.example.test",
      goal: WEB_APP_BASELINE_PRESET,
      artifactsDirectory: join(directory, "artifacts"),
      policy: {
        allowedOrigins: [],
        maxPages: 5,
        maxControlsPerPage: 20,
        maxLinksPerPage: 20,
        allowInsecureHttp: false,
      },
    });
    await workflow.approve(pending.runId, "test-operator", "The test scope is safe.");

    const executed = await workflow.execute(pending.runId);
    expect(executed.status).toBe("passed");
    expect(knowledgeRepository.list()).toEqual([]);
    expect(repository.listEvents(pending.runId).map((event) => event.type)).toContain(
      "knowledge_capture_skipped",
    );

    knowledgeRepository.close();
  });
});
