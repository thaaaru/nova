import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { AppSnapshot, PlannedAction, TestPlan, TestPlanStep } from "../src/domain.js";
import { enforcePlanSafety } from "../src/planning/plan-safety.js";

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

function step(actions: PlannedAction[]): TestPlanStep {
  return {
    id: randomUUID(),
    title: "Step",
    rationale: "because",
    risk: "read_only",
    requiresApproval: false,
    actions,
    expectedResult: "it works",
  };
}

function plan(steps: TestPlanStep[]): TestPlan {
  return {
    id: randomUUID(),
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    summary: "summary",
    discoveredRoutes: ["/"],
    steps,
    warnings: [],
  };
}

describe("enforcePlanSafety", () => {
  it("drops an interact action grounded in a real control when interactions are disabled", () => {
    const grounded: PlannedAction = {
      kind: "interact",
      description: "Click subscribe",
      target: { page: "/", kind: "button", label: "Subscribe" },
    };
    const result = enforcePlanSafety(plan([step([grounded])]), snapshot(), false);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.title).toBe("Baseline page load");
    expect(result.warnings.some((warning) => warning.includes("interactions are disabled"))).toBe(true);
  });

  it("keeps a grounded, non-destructive interact action when interactions are enabled", () => {
    const grounded: PlannedAction = {
      kind: "interact",
      description: "Click subscribe",
      target: { page: "/", kind: "button", label: "Subscribe" },
    };
    const result = enforcePlanSafety(plan([step([grounded])]), snapshot(), true);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.actions).toEqual([grounded]);
    expect(result.warnings).toEqual([]);
  });

  it("drops an interact action whose description matches the destructive denylist", () => {
    const destructive: PlannedAction = {
      kind: "interact",
      description: "Delete the account",
      target: { page: "/", kind: "button", label: "Subscribe" },
    };
    const result = enforcePlanSafety(plan([step([destructive])]), snapshot(), true);

    expect(result.steps[0]?.title).toBe("Baseline page load");
    expect(result.warnings.some((warning) => warning.includes("destructive pattern"))).toBe(true);
  });

  it("drops an interact action whose target doesn't match any discovered control", () => {
    const hallucinated: PlannedAction = {
      kind: "interact",
      description: "Click a button that doesn't exist",
      target: { page: "/", kind: "button", label: "Nonexistent" },
    };
    const result = enforcePlanSafety(plan([step([hallucinated])]), snapshot(), true);

    expect(result.steps[0]?.title).toBe("Baseline page load");
    expect(result.warnings.some((warning) => warning.includes("no matching control"))).toBe(true);
  });

  it("keeps non-interact actions unchanged regardless of the interactions flag", () => {
    const navigate: PlannedAction = { kind: "navigate", description: "Go to home" };
    const result = enforcePlanSafety(plan([step([navigate])]), snapshot(), false);

    expect(result.steps[0]?.actions).toEqual([navigate]);
    expect(result.warnings).toEqual([]);
  });

  it("drops a step entirely when every one of its actions is removed, keeping others intact", () => {
    const destructive: PlannedAction = {
      kind: "interact",
      description: "Pay the invoice",
      target: { page: "/", kind: "button", label: "Subscribe" },
    };
    const navigate: PlannedAction = { kind: "navigate", description: "Go to home" };
    const result = enforcePlanSafety(plan([step([destructive]), step([navigate])]), snapshot(), true);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.actions).toEqual([navigate]);
    expect(result.warnings.some((warning) => warning.includes('Dropped step "Step"'))).toBe(true);
  });
});
