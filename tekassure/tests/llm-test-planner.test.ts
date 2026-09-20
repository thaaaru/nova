import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { AppSnapshot, TestPlan } from "../src/domain.js";
import type { PlanRequest, TestPlanner } from "../src/planning/heuristic-planner.js";
import { LlmTestPlanner, type PlanWithLlmResult } from "../src/planning/llm-test-planner.js";

function snapshot(): AppSnapshot {
  return {
    id: randomUUID(),
    targetUrl: "https://example.test",
    discoveredAt: new Date().toISOString(),
    warnings: [],
    pages: [
      {
        url: "https://example.test/",
        path: "/",
        title: "Home",
        headings: ["Welcome"],
        controls: [{ kind: "button", label: "Subscribe", disabled: false }],
        links: [],
        consoleErrors: [],
        pageErrors: [],
        fingerprint: "fp",
      },
    ],
  };
}

class StubFallback implements TestPlanner {
  calls: PlanRequest[] = [];
  async createPlan(request: PlanRequest): Promise<TestPlan> {
    this.calls.push(request);
    return {
      id: randomUUID(),
      runId: request.runId,
      createdAt: new Date().toISOString(),
      summary: "fallback plan",
      discoveredRoutes: ["/"],
      steps: [
        {
          id: randomUUID(),
          title: "Fallback step",
          rationale: "heuristic",
          risk: "read_only",
          requiresApproval: false,
          actions: [{ kind: "navigate", description: "Go to home" }],
          expectedResult: "loads",
        },
      ],
      warnings: [],
    };
  }
}

const baseRequest: PlanRequest = {
  runId: randomUUID(),
  goal: "web-app-baseline",
  snapshot: snapshot(),
};

describe("LlmTestPlanner", () => {
  it("falls back to the heuristic planner when there's no API key", async () => {
    const fallback = new StubFallback();
    const generate = async (): Promise<PlanWithLlmResult> => ({ ok: false, reason: "no_api_key" });
    const planner = new LlmTestPlanner(fallback, generate);

    const plan = await planner.createPlan(baseRequest);

    expect(plan.summary).toBe("fallback plan");
    expect(fallback.calls).toHaveLength(1);
  });

  it("falls back when the model response fails to validate", async () => {
    const fallback = new StubFallback();
    const generate = async (): Promise<PlanWithLlmResult> => ({
      ok: true,
      draft: { summary: "bad", warnings: [], steps: [{ title: "x" } as never] },
    });
    const planner = new LlmTestPlanner(fallback, generate);

    const plan = await planner.createPlan(baseRequest);

    expect(plan.summary).toBe("fallback plan");
  });

  it("builds a valid TestPlan from a well-formed model response", async () => {
    const fallback = new StubFallback();
    const generate = async (): Promise<PlanWithLlmResult> => ({
      ok: true,
      draft: {
        summary: "Click the subscribe button and confirm it responds.",
        warnings: [],
        steps: [
          {
            title: "Subscribe",
            rationale: "The homepage exposes a subscribe button worth checking.",
            risk: "session_change",
            requiresApproval: true,
            expectedResult: "The button responds without error.",
            cleanup: null,
            actions: [
              {
                kind: "interact",
                description: "Click the subscribe button",
                value: null,
                target: { page: "/", kind: "button", label: "Subscribe", name: null },
              },
            ],
          },
        ],
      },
    });
    const planner = new LlmTestPlanner(fallback, generate);

    const plan = await planner.createPlan(baseRequest);

    expect(fallback.calls).toHaveLength(0);
    expect(plan.summary).toContain("subscribe");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.actions[0]).toMatchObject({
      kind: "interact",
      target: { page: "/", kind: "button", label: "Subscribe" },
    });
  });
});
