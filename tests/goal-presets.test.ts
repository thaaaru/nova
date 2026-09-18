import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  WEB_APP_BASELINE_GOAL,
  WEB_APP_BASELINE_PRESET,
  isWebAppBaselineGoal,
  resolveGoal,
} from "../src/goal-presets.js";
import { HarnessRunInputSchema, type AppSnapshot } from "../src/domain.js";
import { HeuristicTestPlanner } from "../src/planning/heuristic-planner.js";

const snapshot: AppSnapshot = {
  id: randomUUID(),
  targetUrl: "https://example.test/",
  discoveredAt: new Date().toISOString(),
  warnings: [],
  pages: [
    {
      url: "https://example.test/",
      path: "/",
      title: "Example application",
      headings: ["Welcome"],
      controls: [{ kind: "form", disabled: false }],
      links: ["https://example.test/about"],
      consoleErrors: [],
      pageErrors: [],
      fingerprint: "fixture-fingerprint",
    },
  ],
};

describe("web-app-baseline goal preset", () => {
  it("expands the preset into its governed objective without changing custom goals", () => {
    expect(resolveGoal(WEB_APP_BASELINE_PRESET)).toEqual({
      preset: WEB_APP_BASELINE_PRESET,
      text: WEB_APP_BASELINE_GOAL,
    });
    expect(resolveGoal("Verify the marketing homepage.")).toEqual({ text: "Verify the marketing homepage." });
  });

  it("uses the baseline preset when a workflow input omits a goal", () => {
    expect(HarnessRunInputSchema.parse({ targetUrl: "https://example.test/" }).goal).toBe(
      WEB_APP_BASELINE_PRESET,
    );
  });

  it("adds read-only baseline and future-scope review steps", async () => {
    const plan = await new HeuristicTestPlanner().createPlan({
      runId: randomUUID(),
      goal: resolveGoal(WEB_APP_BASELINE_PRESET).text,
      snapshot,
    });

    expect(isWebAppBaselineGoal(WEB_APP_BASELINE_GOAL)).toBe(true);
    expect(plan.steps.find((step) => step.id === "verify-public-route-baseline")).toMatchObject({
      risk: "read_only",
      requiresApproval: false,
    });
    expect(plan.steps.find((step) => step.id === "review-future-web-app-scope")).toMatchObject({
      risk: "read_only",
      requiresApproval: false,
    });
  });
});
