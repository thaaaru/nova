import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { SuggestedTestPlan, TargetManifest, TestPlan, TestRunState } from "../src/domain/index.js";
import { startApprovalServer, type ApprovalServerHandle } from "../src/services/approval/server.js";
import { sha256Of } from "../src/services/hash.js";

/**
 * The local approval page and its server, exercised over real HTTP on
 * loopback. Every negative case here is a control the spec requires:
 * wrong token, missing CSRF, foreign origin, stale plan, replay.
 */

const manifest: TargetManifest = {
  targetId: "shop.example.test",
  baseUrl: "https://shop.example.test/",
  allowedDomains: ["shop.example.test"],
  environment: "staging",
  description: "",
  runExecutionMode: "safe_test",
  createdAt: new Date().toISOString(),
};

function plan(): TestPlan {
  return {
    id: "plan-1",
    version: 1,
    objective: "Confirm the storefront still loads",
    targetManifestId: manifest.targetId,
    createdAt: new Date().toISOString(),
    cases: ["case-a", "case-b"].map((id) => ({
      id,
      title: `Case ${id}`,
      preconditions: [],
      steps: [{ kind: "navigate" as const, url: manifest.baseUrl, timeoutMs: 10_000 }],
      assertions: [{ kind: "urlContains" as const, expected: "shop.example.test" }],
      allowedDomains: manifest.allowedDomains,
      executionMode: "read_only" as const,
      riskLevel: "low" as const,
      timeoutMs: 30_000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      recoveryBudget: 2,
    })),
  };
}

function suggestions(testPlan: TestPlan): SuggestedTestPlan {
  return {
    planId: testPlan.id,
    accepted: testPlan.cases.map((testCase) => ({
      id: testCase.id,
      testCase,
      area: "Home",
      journey: testCase.title,
      persona: null,
      testType: "smoke" as const,
      priority: "low" as const,
      expectedResult: "The page loads.",
      fixtureRefs: [],
      sideEffect: "none" as const,
      evidenceRefs: ["E-001"],
      rationale: "Derived from discovery.",
      confidence: 1,
      source: "rule" as const,
      requiredApprovalLevel: "standard" as const,
    })),
    rejected: [],
  };
}

function run(): TestRunState {
  const testPlan = plan();
  return {
    tenantId: "default",
    projectId: "default",
    runId: randomUUID(),
    targetManifest: manifest,
    objective: testPlan.objective,
    status: "awaiting_approval",
    testPlan,
    planHash: sha256Of(testPlan),
    suggestions: suggestions(testPlan),
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [],
  };
}

let handle: ApprovalServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function serve(state: TestRunState = run()): Promise<{ state: TestRunState; page: string }> {
  handle = await startApprovalServer({ run: state, reviewer: "qa-lead", timeoutMs: 5_000 });
  const response = await fetch(handle.url);
  expect(response.status).toBe(200);
  return { state, page: await response.text() };
}

/** The page carries the CSRF token it must send back; this is how a real browser gets it. */
function csrfFrom(page: string): string {
  const match = /var CSRF = "([0-9a-f]+)"/.exec(page);
  if (!match) {
    throw new Error("The approval page did not carry a CSRF token.");
  }
  return match[1];
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("approval server", () => {
  it("binds loopback only and serves the page behind an unguessable token", async () => {
    const { page } = await serve();
    expect(handle!.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(page).toContain("Nova — approve test plan");
    expect((await fetch(`http://127.0.0.1:${handle!.port}/review/not-the-token`)).status).toBe(404);
  });

  it("renders a self-contained page with no remote assets, analytics, or secrets", async () => {
    const { page } = await serve();
    expect(page).not.toMatch(/src="https?:\/\//);
    expect(page).not.toMatch(/href="https?:\/\/[^"]*\.css/);
    expect(page).not.toMatch(/analytics|googletagmanager|gtag\(/i);
    expect(page).not.toMatch(/password|cookie|authorization|api[_-]?key/i);
    expect(page).not.toContain("localStorage");
  });

  it("sets a strict Content-Security-Policy with no remote sources", async () => {
    handle = await startApprovalServer({ run: run(), reviewer: "qa-lead", timeoutMs: 5_000 });
    const response = await fetch(handle.url);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("records a full approval and derives the exclusions itself", async () => {
    const { state, page } = await serve();
    const response = await post(
      `http://127.0.0.1:${handle!.port}/review/${handle!.url.split("/review/")[1]}/decision`,
      {
        planId: state.testPlan!.id,
        planHash: state.planHash,
        decision: "approved",
        selectedTestCaseIds: ["case-a", "case-b"],
        excludedTestCaseIds: [],
        comment: "Looks right",
      },
      { "x-nova-csrf": csrfFrom(page) },
    );
    expect(response.status).toBe(200);
    const snapshot = await handle!.decision;
    expect(snapshot?.decision).toBe("approved");
    expect(snapshot?.selectedTestCaseIds).toEqual(["case-a", "case-b"]);
    expect(snapshot?.excludedTestCaseIds).toEqual([]);
    expect(snapshot?.comment).toBe("Looks right");
  });

  it("records a partial approval with the unselected cases excluded", async () => {
    const { state, page } = await serve();
    await post(
      `${handle!.url}/decision`,
      {
        planId: state.testPlan!.id,
        planHash: state.planHash,
        decision: "approved",
        selectedTestCaseIds: ["case-a"],
        // Deliberately lies about exclusions; the server must not believe it.
        excludedTestCaseIds: [],
        comment: "",
      },
      { "x-nova-csrf": csrfFrom(page) },
    );
    const snapshot = await handle!.decision;
    expect(snapshot?.selectedTestCaseIds).toEqual(["case-a"]);
    expect(snapshot?.excludedTestCaseIds).toEqual(["case-b"]);
  });

  it("records a change request and a rejection without selecting anything", async () => {
    for (const decision of ["changes_requested", "rejected"] as const) {
      const { state, page } = await serve();
      const response = await post(
        `${handle!.url}/decision`,
        {
          planId: state.testPlan!.id,
          planHash: state.planHash,
          decision,
          selectedTestCaseIds: [],
          excludedTestCaseIds: [],
          comment: "",
        },
        { "x-nova-csrf": csrfFrom(page) },
      );
      expect(response.status).toBe(200);
      expect((await handle!.decision)?.decision).toBe(decision);
      await handle!.close();
      handle = undefined;
    }
  });

  it("refuses an approval that selects nothing", async () => {
    const { state, page } = await serve();
    const response = await post(
      `${handle!.url}/decision`,
      {
        planId: state.testPlan!.id,
        planHash: state.planHash,
        decision: "approved",
        selectedTestCaseIds: [],
        excludedTestCaseIds: [],
        comment: "",
      },
      { "x-nova-csrf": csrfFrom(page) },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("no_selection");
  });

  it("refuses a submission with no CSRF token", async () => {
    const { state } = await serve();
    const response = await post(`${handle!.url}/decision`, {
      planId: state.testPlan!.id,
      planHash: state.planHash,
      decision: "approved",
      selectedTestCaseIds: ["case-a"],
      excludedTestCaseIds: [],
      comment: "",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("csrf_failed");
  });

  it("refuses a submission from a foreign origin", async () => {
    const { state, page } = await serve();
    const response = await post(
      `${handle!.url}/decision`,
      {
        planId: state.testPlan!.id,
        planHash: state.planHash,
        decision: "approved",
        selectedTestCaseIds: ["case-a"],
        excludedTestCaseIds: [],
        comment: "",
      },
      { "x-nova-csrf": csrfFrom(page), origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("origin_failed");
  });

  it("refuses a decision recorded against a stale plan hash", async () => {
    const { state, page } = await serve();
    const response = await post(
      `${handle!.url}/decision`,
      {
        planId: state.testPlan!.id,
        planHash: sha256Of({ different: true }),
        decision: "approved",
        selectedTestCaseIds: ["case-a"],
        excludedTestCaseIds: [],
        comment: "",
      },
      { "x-nova-csrf": csrfFrom(page) },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("stale_plan");
  });

  it("refuses a case id that is not part of the plan", async () => {
    const { state, page } = await serve();
    const response = await post(
      `${handle!.url}/decision`,
      {
        planId: state.testPlan!.id,
        planHash: state.planHash,
        decision: "approved",
        selectedTestCaseIds: ["case-z"],
        excludedTestCaseIds: [],
        comment: "",
      },
      { "x-nova-csrf": csrfFrom(page) },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("unknown_case");
  });

  it("refuses a replayed second submission", async () => {
    const { state, page } = await serve();
    const body = {
      planId: state.testPlan!.id,
      planHash: state.planHash,
      decision: "approved" as const,
      selectedTestCaseIds: ["case-a"],
      excludedTestCaseIds: [],
      comment: "",
    };
    const headers = { "x-nova-csrf": csrfFrom(page) };
    expect((await post(`${handle!.url}/decision`, body, headers)).status).toBe(200);
    const replay = await post(`${handle!.url}/decision`, body, headers);
    expect(replay.status).toBe(409);
  });
});
