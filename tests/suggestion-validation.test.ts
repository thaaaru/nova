import { describe, expect, it } from "vitest";

import type { DiscoverySnapshot, TargetManifest, TestCase } from "../src/domain/index.js";
import { buildEvidencePackage } from "../src/services/llm/evidence.js";
import {
  classifySideEffect,
  requiredApprovalLevel,
  validateSuggestions,
  type SuggestionCandidate,
} from "../src/services/testmap/suggestion-validation.js";
import { suggestTestCases } from "../src/services/testmap/suggestion-service.js";

/**
 * The deterministic gate on suggested test cases. Nothing here consults
 * a model: these are the checks that make a model's proposal safe to put
 * in front of a reviewer — and that reject it when it is not.
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

const snapshot: DiscoverySnapshot = {
  runId: "22222222-2222-4222-8222-222222222222",
  targetUrl: manifest.baseUrl,
  visitedUrls: [manifest.baseUrl, "https://shop.example.test/offers"],
  pages: [
    {
      url: manifest.baseUrl,
      title: "Demo Shop",
      forms: [],
      buttons: [{ kind: "button", text: "Create offer" }],
      links: [],
      consoleErrors: [],
    },
  ],
  apiEndpoints: [],
  capturedAt: new Date().toISOString(),
};

const evidence = buildEvidencePackage({ runId: snapshot.runId, snapshot });

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "candidate",
    title: "Storefront loads",
    preconditions: [],
    steps: [{ kind: "navigate", url: manifest.baseUrl, timeoutMs: 10_000 }],
    assertions: [{ kind: "urlContains", expected: "shop.example.test" }],
    allowedDomains: manifest.allowedDomains,
    executionMode: "read_only",
    riskLevel: "low",
    timeoutMs: 30_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryBudget: 2,
    ...overrides,
  };
}

function candidate(overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    testCase: testCase(),
    area: "Home",
    journey: "Load the storefront",
    persona: null,
    testType: "smoke",
    priority: "low",
    expectedResult: "The storefront loads.",
    fixtureRefs: [],
    evidenceRefs: [evidence.items[0].evidenceId],
    rationale: "Observed during discovery.",
    confidence: 0.9,
    source: "llm",
    ...overrides,
  };
}

function validate(candidates: SuggestionCandidate[], extra: Record<string, unknown> = {}) {
  return validateSuggestions(candidates, { planId: "plan-1", manifest, snapshot, evidence, ...extra });
}

describe("validateSuggestions", () => {
  it("accepts a well-formed, evidenced, in-scope candidate and assigns it a plan-scoped id", () => {
    const result = validate([candidate()]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].id).toBe("plan-1-c1");
    expect(result.accepted[0].testCase.id).toBe("plan-1-c1");
  });

  it("rejects a case that declares a domain outside the manifest", () => {
    const result = validate([candidate({ testCase: testCase({ allowedDomains: ["attacker.test"] }) })]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].check).toBe("scope");
  });

  it("rejects a case that navigates off the approved target", () => {
    const result = validate([
      candidate({
        testCase: testCase({
          steps: [{ kind: "navigate", url: "https://attacker.test/", timeoutMs: 10_000 }],
        }),
      }),
    ]);
    expect(result.rejected[0].check).toBe("target");
  });

  it("rejects a route discovery never observed", () => {
    const result = validate([
      candidate({
        testCase: testCase({
          steps: [{ kind: "navigate", url: "https://shop.example.test/invented", timeoutMs: 10_000 }],
        }),
      }),
    ]);
    expect(result.rejected[0].check).toBe("route_existence");
  });

  it("rejects an unknown persona and an unavailable fixture", () => {
    expect(
      validate([candidate({ persona: "ghost" })], { knownPersonaIds: ["clerk"] }).rejected[0].check,
    ).toBe("persona_existence");
    expect(
      validate([candidate({ fixtureRefs: ["missing"] })], { knownFixtureIds: ["orders"] }).rejected[0].check,
    ).toBe("fixture_availability");
  });

  it("rejects a state-changing case when the manifest is in observe mode", () => {
    const result = validateSuggestions(
      [candidate({ testCase: testCase({ executionMode: "state_changing" }) })],
      { planId: "plan-1", manifest: { ...manifest, runExecutionMode: "observe" }, snapshot, evidence },
    );
    expect(result.rejected[0].check).toBe("policy");
  });

  it("rejects an irreversible or high-risk case outside destructive mode", () => {
    const result = validate([
      candidate({
        testCase: testCase({
          title: "Delete every offer",
          executionMode: "state_changing",
          riskLevel: "high",
        }),
      }),
    ]);
    expect(result.rejected[0].check).toBe("policy");
  });

  it("rejects a duplicate of an already-accepted case", () => {
    const result = validate([candidate(), candidate()]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0].check).toBe("duplicate");
  });

  it("rejects a model-suggested case citing evidence that was never collected", () => {
    expect(validate([candidate({ evidenceRefs: ["E-999"] })]).rejected[0].check).toBe(
      "evidence_traceability",
    );
    expect(validate([candidate({ evidenceRefs: [] })]).rejected[0].check).toBe("evidence_traceability");
  });

  it("rejects a case that could not actually be executed as written", () => {
    expect(validate([candidate({ testCase: testCase({ assertions: [] }) })]).rejected[0].check).toBe(
      "executability",
    );
    expect(
      validate([
        candidate({
          testCase: testCase({
            steps: [
              { kind: "navigate", url: manifest.baseUrl, timeoutMs: 10_000 },
              { kind: "click", timeoutMs: 10_000 },
            ],
          }),
        }),
      ]).rejected[0].check,
    ).toBe("executability");
  });

  it("classifies side effects from the case itself, not from what a suggestion claims", () => {
    expect(classifySideEffect(testCase())).toBe("none");
    expect(classifySideEffect(testCase({ executionMode: "state_changing" }))).toBe("creates_data");
    expect(
      classifySideEffect(testCase({ executionMode: "state_changing", title: "Update the profile" })),
    ).toBe("modifies_data");
    expect(classifySideEffect(testCase({ executionMode: "state_changing", title: "Delete an offer" }))).toBe(
      "deletes_data",
    );
  });

  it("derives the required approval level deterministically", () => {
    expect(requiredApprovalLevel(testCase(), "none")).toBe("standard");
    expect(requiredApprovalLevel(testCase(), "deletes_data")).toBe("elevated");
    expect(requiredApprovalLevel(testCase({ riskLevel: "high" }), "none")).toBe("elevated");
  });
});

describe("suggestTestCases", () => {
  it("always produces a plan from the rule pack alone, with no model configured", async () => {
    const result = await suggestTestCases({
      planId: "plan-1",
      objective: "Confirm the storefront still loads",
      manifest,
      snapshot,
      evidence,
    });
    expect(result.accepted.length).toBeGreaterThan(0);
    expect(result.accepted.every((entry) => entry.source === "rule")).toBe(true);
  });

  it("falls back to the rule pack when the model call fails", async () => {
    const result = await suggestTestCases({
      planId: "plan-1",
      objective: "Confirm the storefront still loads",
      manifest,
      snapshot,
      evidence,
      identification: {
        applicationName: "Demo Shop",
        applicationType: "storefront",
        businessDomain: null,
        primaryPurpose: "Sell things",
        likelyPersonas: [],
        coreEntities: [],
        functionalAreas: [],
        likelyJourneys: [],
        authenticationPattern: null,
        relevantDocuments: [],
        assumptions: [],
        unknowns: [],
        confidence: 0.8,
        evidenceRefs: [evidence.items[0].evidenceId],
      },
      suggester: async () => {
        throw new Error("provider unavailable");
      },
    });
    expect(result.accepted.length).toBeGreaterThan(0);
  });

  it("merges validated model candidates alongside the rule pack", async () => {
    const result = await suggestTestCases({
      planId: "plan-1",
      objective: "Confirm the storefront still loads",
      manifest,
      snapshot,
      evidence,
      identification: {
        applicationName: "Demo Shop",
        applicationType: "storefront",
        businessDomain: null,
        primaryPurpose: "Sell things",
        likelyPersonas: [],
        coreEntities: [],
        functionalAreas: [],
        likelyJourneys: [],
        authenticationPattern: null,
        relevantDocuments: [],
        assumptions: [],
        unknowns: [],
        confidence: 0.8,
        evidenceRefs: [evidence.items[0].evidenceId],
      },
      suggester: async () => [
        candidate({
          testCase: testCase({
            title: "Offers page loads",
            steps: [{ kind: "navigate", url: "https://shop.example.test/offers", timeoutMs: 10_000 }],
          }),
        }),
      ],
    });
    expect(result.accepted.some((entry) => entry.source === "llm")).toBe(true);
  });
});
