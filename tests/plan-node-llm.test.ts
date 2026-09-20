import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { DiscoverySnapshot, TargetManifest, TestCase, TestRunState } from "../src/domain/index.js";
import { createOpenAiPlanGenerator } from "../src/services/llm/openai-plan-generator.js";
import { createPlanNode } from "../src/workflow/nodes/plan.js";

const manifest: TargetManifest = {
  targetId: "demo-app",
  baseUrl: "https://shop.example.test/",
  allowedDomains: ["shop.example.test"],
  environment: "local",
  description: "",
  runExecutionMode: "safe_test",
  createdAt: new Date().toISOString(),
};

const snapshot: DiscoverySnapshot = {
  runId: "placeholder",
  targetUrl: manifest.baseUrl,
  visitedUrls: [manifest.baseUrl],
  pages: [
    {
      url: manifest.baseUrl,
      title: "Demo Shop",
      forms: [],
      buttons: [],
      links: [],
      consoleErrors: [],
    },
  ],
  apiEndpoints: [],
  capturedAt: new Date().toISOString(),
};

function baseRun(overrides: Partial<TestRunState> = {}): TestRunState {
  return {
    tenantId: "default",
    projectId: "default",
    runId: randomUUID(),
    targetManifest: manifest,
    status: "planning",
    objective: "Confirm the storefront still loads",
    discoverySnapshot: { ...snapshot, runId: randomUUID() },
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [],
    ...overrides,
  };
}

function llmCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "llm-proposed",
    title: "LLM-proposed case",
    preconditions: [],
    steps: [{ kind: "navigate", url: manifest.baseUrl, timeoutMs: 15_000 }],
    assertions: [{ kind: "titleContains", expected: "Demo Shop" }],
    allowedDomains: ["shop.example.test"],
    executionMode: "read_only",
    riskLevel: "low",
    timeoutMs: 30_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryBudget: 2,
    ...overrides,
  };
}

describe("createPlanNode — LLM proposal, code-enforced scope", () => {
  it("stays on the deterministic template when no generateCases dependency is configured", async () => {
    const node = createPlanNode();
    const result = await node({ run: baseRun() });
    expect(result.run?.testPlan?.cases.length).toBeGreaterThan(0);
    const event = result.run?.auditEvents.at(-1);
    expect(event?.detail.authoredBy).toBe("template");
  });

  it("adopts the LLM's proposed cases when every one passes checkCaseScope", async () => {
    const node = createPlanNode({
      generateCases: async () => [llmCase()],
    });
    const result = await node({ run: baseRun() });
    expect(result.run?.testPlan?.cases).toEqual([llmCase()]);
    const event = result.run?.auditEvents.at(-1);
    expect(event?.detail.authoredBy).toBe("llm");
    expect(event?.detail.rejectedCaseCount).toBe(0);
  });

  it("silently drops any proposed case naming a domain outside the manifest, keeping only what's in scope", async () => {
    const inScope = llmCase({ id: "in-scope" });
    const outOfScope = llmCase({ id: "out-of-scope", allowedDomains: ["attacker.example"] });
    const node = createPlanNode({
      generateCases: async () => [inScope, outOfScope],
    });
    const result = await node({ run: baseRun() });
    const caseIds = result.run?.testPlan?.cases.map((testCase) => testCase.id);
    expect(caseIds).toEqual(["in-scope"]);
    const event = result.run?.auditEvents.at(-1);
    expect(event?.detail.authoredBy).toBe("llm");
    expect(event?.detail.rejectedCaseCount).toBe(1);
  });

  it("falls back to the template plan — never an empty plan — when every proposed case is out of scope", async () => {
    const node = createPlanNode({
      generateCases: async () => [llmCase({ allowedDomains: ["attacker.example"] })],
    });
    const result = await node({ run: baseRun() });
    expect(result.run?.testPlan?.cases.length).toBeGreaterThan(0);
    const event = result.run?.auditEvents.at(-1);
    expect(event?.detail.authoredBy).toBe("template");
    expect(event?.detail.rejectedCaseCount).toBe(1);
  });

  it("falls back to the template plan when the LLM call throws (rate limit, network, malformed output)", async () => {
    const node = createPlanNode({
      generateCases: async () => {
        throw new Error("simulated OpenAI outage");
      },
    });
    const result = await node({ run: baseRun() });
    expect(result.run?.testPlan?.cases.length).toBeGreaterThan(0);
    const event = result.run?.auditEvents.at(-1);
    expect(event?.detail.authoredBy).toBe("template");
  });

  it("throws when run.objective is missing", async () => {
    const node = createPlanNode();
    await expect(node({ run: baseRun({ objective: undefined }) })).rejects.toThrow(/objective/);
  });

  it("throws when run.discoverySnapshot is missing", async () => {
    const node = createPlanNode();
    await expect(node({ run: baseRun({ discoverySnapshot: undefined }) })).rejects.toThrow(
      /discovery snapshot/,
    );
  });
});

describe("createOpenAiPlanGenerator — real OpenAI call", () => {
  // Requires a real OPENAI_API_KEY in the environment; skipped otherwise so
  // the suite never depends on a paid third-party API being reachable in
  // CI. Run locally with OPENAI_API_KEY set to exercise the real call.
  const hasKey = Boolean(process.env.OPENAI_API_KEY);

  it.skipIf(!hasKey)(
    "proposes cases shaped like the domain schema from a real discovery snapshot",
    async () => {
      const generate = createOpenAiPlanGenerator({ apiKey: process.env.OPENAI_API_KEY as string });
      const cases = await generate({
        objective: "Confirm the storefront homepage still loads and shows its title",
        manifest,
        snapshot,
      });
      expect(cases.length).toBeGreaterThan(0);
      for (const testCase of cases) {
        expect(testCase.allowedDomains).toEqual(manifest.allowedDomains);
        expect(testCase.steps.length).toBeGreaterThan(0);
        expect(testCase.assertions.length).toBeGreaterThan(0);
      }
    },
    30_000,
  );
});
