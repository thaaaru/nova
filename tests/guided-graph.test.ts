import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DiscoverySnapshot,
  ExecutionResult,
  TargetManifest,
  TestRunState,
} from "../src/domain/index.js";
import { buildNovaGraph, type NovaGraph } from "../src/workflow/graph.js";
import { sha256Of } from "../src/services/hash.js";
import { createExecutionRequest, verifyAndRecordDecision } from "../src/services/approval/decision.js";

/**
 * The guided workflow end to end, with every external effect stubbed:
 * no browser, no network, no model. What is under test is the graph's
 * own routing, its interrupts, and the fact that each human decision —
 * and only that decision — unblocks the next stage.
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

function snapshotFor(runId: string): DiscoverySnapshot {
  return {
    runId,
    targetUrl: manifest.baseUrl,
    visitedUrls: [manifest.baseUrl],
    pages: [
      {
        url: manifest.baseUrl,
        title: "Demo Shop",
        forms: [],
        buttons: [{ kind: "button", text: "Create offer" }],
        links: [{ kind: "link", text: "Suppliers", href: "/suppliers" }],
        consoleErrors: [],
      },
    ],
    apiEndpoints: [],
    capturedAt: new Date().toISOString(),
  };
}

function newRun(overrides: Partial<TestRunState> = {}): TestRunState {
  return {
    tenantId: "default",
    projectId: "default",
    runId: randomUUID(),
    targetManifest: manifest,
    status: "new",
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [],
    ...overrides,
  };
}

let tempDir: string;
let graph: NovaGraph;
let executedCaseIds: string[];
let discoverCalls: number;
let identifyCalls: number;
let authRequired: boolean;

function buildGraph(): NovaGraph {
  return buildNovaGraph({
    discover: {
      discover: async ({ runId }) => {
        discoverCalls += 1;
        return snapshotFor(runId);
      },
    },
    context: {
      detectAuth: async () =>
        authRequired ? { required: true, reason: "Redirected to /login" } : { required: false },
      discover: async ({ runId }) => {
        discoverCalls += 1;
        return snapshotFor(runId);
      },
    },
    // No document discovery and no model: the flow must still complete,
    // recording an honest degraded identification.
    documents: {},
    identification: {
      identify: async (evidence) => {
        identifyCalls += 1;
        return {
          identification: {
            applicationName: "Demo Shop",
            applicationType: "storefront",
            businessDomain: null,
            primaryPurpose: "Sell things",
            likelyPersonas: [{ name: "Shopper", evidenceRefs: [evidence.items[0].evidenceId] }],
            coreEntities: [],
            functionalAreas: [],
            likelyJourneys: [],
            authenticationPattern: null,
            relevantDocuments: [],
            assumptions: [],
            unknowns: [],
            confidence: 0.9,
            evidenceRefs: [evidence.items[0].evidenceId],
          },
          validationNotes: [],
        };
      },
      provider: "test-provider",
      model: "test-model",
    },
    plan: {},
    execute: {
      executeTestCase: async ({ testCase }) => {
        executedCaseIds.push(testCase.id);
        const result: ExecutionResult = {
          caseId: testCase.id,
          attempts: 1,
          stepResults: [{ stepIndex: 0, status: "passed", durationMs: 1 }],
          assertionResults: [
            { kind: "urlContains", expected: "shop.example.test", passed: true, observed: manifest.baseUrl },
          ],
          recoveryAttempts: [],
          screenshots: [],
          consoleLogs: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
        return result;
      },
      secretResolver: { resolve: () => undefined },
      artifactsDirectory: tempDir,
    },
    report: { artifactsDirectory: tempDir },
    checkpointDatabasePath: ":memory:",
  });
}

async function invoke(run: TestRunState): Promise<TestRunState> {
  const result = await graph.invoke({ run }, { configurable: { thread_id: run.runId } });
  return result.run;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-guided-test-"));
  executedCaseIds = [];
  discoverCalls = 0;
  identifyCalls = 0;
  authRequired = false;
  graph = buildGraph();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Drives a fresh run up to the identification confirmation interrupt. */
async function toIdentification(): Promise<TestRunState> {
  const run = await invoke(newRun());
  expect(run.status).toBe("identification_confirmation");
  return run;
}

/** Confirms identification and supplies an objective, landing on the approval interrupt. */
async function toAwaitingApproval(): Promise<TestRunState> {
  const identified = await toIdentification();
  const confirmed = await invoke({
    ...identified,
    identification: {
      ...identified.identification!,
      confirmedBy: "qa-lead",
      confirmedAt: new Date().toISOString(),
    },
    objective: "Confirm the storefront still loads",
  });
  expect(confirmed.status).toBe("awaiting_approval");
  return confirmed;
}

describe("guided workflow transitions", () => {
  it("runs resolve_inputs -> entry context -> documents -> identification and stops for confirmation", async () => {
    const run = await toIdentification();
    const types = run.auditEvents.map((event) => event.type);
    expect(types).toContain("inputs_resolved");
    expect(types).toContain("entry_context_captured");
    expect(types).toContain("documents_discovered");
    expect(types).toContain("application_identified");
    expect(run.evidencePackage?.items.length).toBeGreaterThan(0);
    expect(run.identification?.identification.applicationName).toBe("Demo Shop");
  });

  it("stops and asks when authentication is required, and continues once a choice is recorded", async () => {
    authRequired = true;
    const blocked = await invoke(newRun());
    expect(blocked.status).toBe("authentication_required");
    expect(blocked.authenticationReason).toContain("/login");

    const continued = await invoke({ ...blocked, authenticationMode: "public_only" });
    expect(continued.status).toBe("identification_confirmation");
    expect(continued.auditEvents.map((event) => event.type)).toContain("authentication_resolved");
  });

  it("will not pass identification without a human confirmation", async () => {
    const run = await toIdentification();
    const again = await invoke(run);
    expect(again.status).toBe("identification_confirmation");
    expect(again.discoverySnapshot?.pages.length).toBeGreaterThan(0);
  });

  it("does not call the model again when resuming the same evidence snapshot", async () => {
    const run = await toIdentification();
    const callsAfterFirstPass = identifyCalls;
    await invoke(run);
    expect(identifyCalls).toBe(callsAfterFirstPass);
  });

  /**
   * Regression: confirming the identification used to jump straight into
   * suggestion through a static edge, so a run whose objective had not
   * been collected yet died with "suggest_test_cases requires
   * run.objective". The objective is asked for *after* the application
   * model is confirmed, so this path has to be able to stop and wait.
   */
  it("stops and waits for an objective after identification instead of crashing into suggestion", async () => {
    const identified = await toIdentification();
    const confirmed = await invoke({
      ...identified,
      identification: {
        ...identified.identification!,
        confirmedBy: "qa-lead",
        confirmedAt: new Date().toISOString(),
      },
    });
    expect(confirmed.status).toBe("planning");
    expect(confirmed.objective).toBeUndefined();
    expect(confirmed.testPlan).toBeUndefined();
    const types = confirmed.auditEvents.map((event) => event.type);
    expect(types).toContain("identification_confirmed");
    expect(types).toContain("application_model_reconciled");

    // And supplying the objective later picks up exactly where it stopped.
    const planned = await invoke({ ...confirmed, objective: "Confirm the storefront still loads" });
    expect(planned.status).toBe("awaiting_approval");
    expect(planned.testPlan?.cases.length).toBeGreaterThan(0);
  });

  it("reaches a validated, hash-bound plan and stops for approval", async () => {
    const run = await toAwaitingApproval();
    expect(run.testPlan?.cases.length).toBeGreaterThan(0);
    expect(run.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.suggestions?.accepted.length).toBeGreaterThan(0);
    expect(run.auditEvents.map((event) => event.type)).toContain("approval_review_opened");
  });

  it("never auto-executes on the same invocation as the approval", async () => {
    const run = await toAwaitingApproval();
    const approved = await invoke({
      ...run,
      approval: {
        planId: run.testPlan!.id,
        decision: "approved",
        reviewer: "qa-lead",
        decidedAt: new Date().toISOString(),
      },
    });
    expect(approved.status).toBe("approved");
    expect(executedCaseIds).toEqual([]);
  });

  it("loops back through revision on a changes-requested decision", async () => {
    const run = await toAwaitingApproval();
    const revised = await invoke({
      ...run,
      approval: {
        planId: run.testPlan!.id,
        decision: "changes_requested",
        reviewer: "qa-lead",
        decidedAt: new Date().toISOString(),
        note: "Add a checkout case",
      },
    });
    expect(revised.auditEvents.map((event) => event.type)).toContain("plan_changes_requested");
    expect(revised.auditEvents.map((event) => event.type)).toContain("plan_revision_requested");
    expect(revised.revisionCount).toBe(1);
    expect(revised.status).toBe("awaiting_approval");
    expect(revised.approval).toBeUndefined();
    expect(executedCaseIds).toEqual([]);
  });

  it("terminates on rejection and stays terminated on a later invocation", async () => {
    const run = await toAwaitingApproval();
    const rejected = await invoke({
      ...run,
      approval: {
        planId: run.testPlan!.id,
        decision: "rejected",
        reviewer: "qa-lead",
        decidedAt: new Date().toISOString(),
      },
    });
    expect(rejected.status).toBe("rejected");
    expect(await invoke(rejected).then((next) => next.status)).toBe("rejected");
    expect(executedCaseIds).toEqual([]);
  });

  it("separates the execution request from the approval, then runs only the requested cases", async () => {
    const run = await toAwaitingApproval();
    const decision = verifyAndRecordDecision({
      run,
      reviewer: "qa-lead",
      payload: {
        planId: run.testPlan!.id,
        planHash: run.planHash,
        decision: "approved",
        selectedTestCaseIds: [run.testPlan!.cases[0].id],
        excludedTestCaseIds: [],
        comment: "",
      },
      expected: {
        target: manifest.baseUrl,
        environment: manifest.environment,
        scopeDomains: manifest.allowedDomains,
      },
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    const approved = await invoke({
      ...run,
      approvedPlanSnapshot: decision.snapshot,
      approval: {
        planId: decision.snapshot.planId,
        decision: "approved",
        reviewer: decision.snapshot.reviewer,
        decidedAt: decision.snapshot.decidedAt,
        approvalId: decision.snapshot.approvalId,
        selectedTestCaseIds: decision.snapshot.selectedTestCaseIds,
      },
    });
    expect(approved.status).toBe("approved");
    expect(executedCaseIds).toEqual([]);

    const executionRequest = createExecutionRequest({
      run: approved,
      snapshot: decision.snapshot,
      requestedBy: "qa-lead",
    });
    const finished = await invoke({ ...approved, executionRequest });

    const types = finished.auditEvents.map((event) => event.type);
    expect(types).toContain("execution_requested");
    expect(types).toContain("execution_preflight_passed");
    expect(executedCaseIds).toEqual([decision.snapshot.selectedTestCaseIds[0]]);
    expect(["completed", "failed"]).toContain(finished.status);
    expect(finished.artifactReferences.length).toBeGreaterThan(0);
  });

  it("refuses an execution request whose plan hash no longer matches", async () => {
    const run = await toAwaitingApproval();
    const approved: TestRunState = {
      ...run,
      status: "approved",
      approval: {
        planId: run.testPlan!.id,
        decision: "approved",
        reviewer: "qa-lead",
        decidedAt: new Date().toISOString(),
      },
      executionRequest: {
        executionRequestId: "EXR-BAD",
        planId: run.testPlan!.id,
        planHash: sha256Of({ tampered: true }),
        approvalId: "APV-BAD",
        selectedTestCaseIds: [run.testPlan!.cases[0].id],
        target: manifest.baseUrl,
        environment: manifest.environment,
        scopeDomains: manifest.allowedDomains,
        policyVersion: "policy-1",
        requestedAt: new Date().toISOString(),
        requestedBy: "attacker",
        idempotencyKey: sha256Of({ tampered: true }),
      },
    };
    await expect(invoke(approved)).rejects.toThrow(/does not match the approved plan/);
    expect(executedCaseIds).toEqual([]);
  });

  it("does not repeat a completed crawl when resuming an already-discovered run", async () => {
    const run = await toAwaitingApproval();
    const crawlsSoFar = discoverCalls;
    await invoke(run);
    expect(discoverCalls).toBe(crawlsSoFar);
  });
});
