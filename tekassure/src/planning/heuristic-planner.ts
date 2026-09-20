import { randomUUID } from "node:crypto";

import type { AppSnapshot, KnowledgeEntry, TestPlan, TestPlanStep } from "../domain.js";
import { isWebAppBaselineGoal } from "../goal-presets.js";

export type PlanRequest = {
  runId: string;
  goal: string;
  snapshot: AppSnapshot;
  /** Whether this run permits "interact" actions. Ignored by this planner — it never proposes any. */
  allowInteractions?: boolean;
  /** Prior knowledge-base entries for this target, for planners that can use them. Ignored by this planner. */
  knowledge?: KnowledgeEntry[];
};

export interface TestPlanner {
  createPlan(request: PlanRequest): Promise<TestPlan>;
}

/**
 * A conservative baseline planner. It creates a reviewable plan from structured
 * discovery evidence, purely by pattern-matching — no interact actions, no
 * reasoning about the app's purpose. Serves as the fallback for LlmTestPlanner
 * when no OPENAI_API_KEY is configured or a model call fails.
 */
export class HeuristicTestPlanner implements TestPlanner {
  async createPlan({ runId, goal, snapshot }: PlanRequest): Promise<TestPlan> {
    const startPage = snapshot.pages[0];
    if (!startPage) {
      throw new Error("Cannot create a test plan without a discovered page.");
    }

    const loginPage = snapshot.pages.find((page) =>
      page.controls.some((control) => {
        const text = `${control.label ?? ""} ${control.name ?? ""} ${control.inputType ?? ""}`.toLowerCase();
        return text.includes("password") || text.includes("sign in") || text.includes("log in");
      }),
    );

    const steps: TestPlanStep[] = [
      {
        id: "review-discovery",
        title: "Review the discovered application map",
        rationale:
          "Confirm that the pages and controls discovered without interaction match the intended test scope.",
        risk: "read_only",
        requiresApproval: false,
        actions: [
          {
            kind: "inspect",
            description: `Review ${snapshot.pages.length} discovered route(s) and their captured evidence.`,
          },
        ],
        expectedResult: "The target application and the proposed scope are understood before execution.",
      },
      {
        id: "open-start-page",
        title: `Open ${startPage.path}`,
        rationale: "Begin from the initial page observed during read-only discovery.",
        risk: "read_only",
        requiresApproval: false,
        actions: [
          { kind: "navigate", description: `Navigate to ${startPage.url}.` },
          {
            kind: "assert",
            description: `Verify the page title contains \"${startPage.title || "the expected title"}\".`,
          },
        ],
        expectedResult: "The initial application page is reachable and renders its expected primary content.",
      },
    ];

    if (isWebAppBaselineGoal(goal)) {
      steps.push(
        {
          id: "verify-public-route-baseline",
          title: "Verify public route reachability and content baseline",
          rationale:
            "Use only safe direct navigation to re-check the routes, titles, and primary headings captured during discovery.",
          risk: "read_only",
          requiresApproval: false,
          actions: [
            {
              kind: "navigate",
              description: `Navigate directly to each of the ${snapshot.pages.length} discovered same-origin route(s).`,
            },
            {
              kind: "assert",
              description:
                "Assert each route's expected title and first captured heading, then retain screenshot evidence.",
            },
          ],
          expectedResult:
            "Every approved safe route is reachable and renders its expected title and primary content heading.",
        },
        {
          id: "review-future-web-app-scope",
          title: "Review interaction and quality candidates for separate approval",
          rationale:
            "Discovery identifies controls and links without interacting with them; forms, authentication, accessibility, responsiveness, performance, and security require dedicated scope and evidence.",
          risk: "read_only",
          requiresApproval: false,
          actions: [
            {
              kind: "inspect",
              description:
                "Review discovered links and controls without clicking, filling, submitting, authenticating, or uploading.",
            },
            {
              kind: "inspect",
              description:
                "Record separately proposed checks for interactive journeys and quality areas; do not treat discovery metadata as completed accessibility, performance, or security testing.",
            },
          ],
          expectedResult:
            "The review distinguishes completed public-route evidence from interaction and quality scopes that need separate approval.",
        },
      );
    }

    if (loginPage) {
      steps.push({
        id: "authenticate-test-user",
        title: "Authenticate with an approved test account",
        rationale:
          "The discovery map indicates an authentication boundary that may be required for the requested journey.",
        risk: "session_change",
        requiresApproval: true,
        actions: [
          { kind: "navigate", description: `Navigate to ${loginPage.url}.` },
          {
            kind: "authenticate",
            description:
              "Use the named test-account secrets through the browser adapter; never expose their values to the model.",
            secretReference: "TEST_ACCOUNT_<ROLE>",
          },
        ],
        expectedResult:
          "The test session reaches the intended authenticated state without exposing credentials.",
      });
    }

    steps.push({
      id: "exercise-requested-journey",
      title: `Exercise requested journey: ${goal}`,
      rationale:
        "The user goal is not executed until this proposed state-changing scope has been explicitly approved.",
      risk: "state_change",
      requiresApproval: true,
      actions: [
        {
          kind: "interact",
          description:
            "Translate the approved journey into constrained Playwright tool calls using only controls found in the app map.",
        },
        {
          kind: "assert",
          description:
            "Verify the expected result with deterministic Playwright assertions and capture evidence.",
        },
      ],
      expectedResult: `The approved behavior for \"${goal}\" is verified with reproducible evidence.`,
      cleanup: "Define a test-data cleanup action before any persistent state is created.",
    });

    return {
      id: randomUUID(),
      runId,
      createdAt: new Date().toISOString(),
      summary: `Read-only discovery found ${snapshot.pages.length} route(s). The requested goal is proposed for approval, not executed.`,
      discoveredRoutes: snapshot.pages.map((page) => page.path),
      steps,
      warnings: [
        ...snapshot.warnings,
        "This initial planner is deterministic. Replace it with a schema-validated LLM planner only after a provider and evaluation suite are configured.",
      ],
    };
  }
}
