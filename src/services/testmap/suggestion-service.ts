import type {
  ApplicationEvidencePackage,
  ApplicationIdentification,
  DiscoverySnapshot,
  SuggestedTestPlan,
  TargetManifest,
  TestCase,
  TestPlan,
} from "../../domain/index.js";
import { generatePlanFromDiscovery } from "../../workflow/plan-templates.js";
import type { TestCaseSuggester } from "../llm/suggest-test-cases.js";
import {
  validateSuggestions,
  type SuggestionCandidate,
  type ValidationContext,
} from "./suggestion-validation.js";

/**
 * Turns the confirmed Application Model plus discovery into a reviewable
 * set of suggested test cases: the deterministic rule pack first (it
 * always produces something, so a plan is never empty and never depends
 * on a model being reachable), then optionally a model's extra
 * candidates, then one deterministic validation pass over both.
 *
 * The model's contribution is strictly additive and strictly checked. A
 * failed or unavailable model costs the extra candidates and nothing
 * else.
 */

export type SuggestTestCasesOptions = {
  planId: string;
  objective: string;
  manifest: TargetManifest;
  snapshot: DiscoverySnapshot;
  evidence?: ApplicationEvidencePackage;
  identification?: ApplicationIdentification;
  /** Omitted when no model is configured — the rule pack alone then produces the plan. */
  suggester?: TestCaseSuggester;
  knownPersonaIds?: string[];
  knownFixtureIds?: string[];
  onProgress?: (message: string) => void;
};

export async function suggestTestCases(options: SuggestTestCasesOptions): Promise<SuggestedTestPlan> {
  const rulePlan = generatePlanFromDiscovery(
    options.planId,
    options.manifest,
    options.snapshot,
    options.objective,
  );
  const candidates: SuggestionCandidate[] = rulePlan.cases.map((testCase) =>
    ruleCandidate(testCase, options.snapshot, options.evidence),
  );

  if (options.suggester && options.identification && options.evidence) {
    try {
      options.onProgress?.("Asking the model for additional test cases...");
      const proposed = await options.suggester({
        objective: options.objective,
        manifest: options.manifest,
        identification: options.identification,
        evidence: options.evidence,
        routes: routesFor(options.snapshot),
      });
      candidates.push(...proposed);
    } catch {
      // The rule pack above already stands in: suggestion never blocks on
      // a third-party API, exactly like the existing plan node's LLM path.
    }
  }

  const context: ValidationContext = {
    planId: options.planId,
    manifest: options.manifest,
    snapshot: options.snapshot,
    evidence: options.evidence,
    knownPersonaIds: options.knownPersonaIds,
    knownFixtureIds: options.knownFixtureIds,
  };
  return validateSuggestions(candidates, context);
}

/** The executable plan the approval page shows and the executor later runs — built only from accepted suggestions. */
export function toTestPlan(suggested: SuggestedTestPlan, template: TestPlan): TestPlan {
  const cases = suggested.accepted.map((suggestion) => suggestion.testCase);
  return { ...template, id: suggested.planId, cases: cases.length > 0 ? cases : template.cases };
}

/**
 * Wraps a deterministic rule-pack case in review metadata. Its evidence
 * references are resolved by matching the route it navigates to against
 * the evidence package's own `source` paths, so even rule-derived cases
 * stay traceable back to an observation.
 */
function ruleCandidate(
  testCase: TestCase,
  snapshot: DiscoverySnapshot,
  evidence?: ApplicationEvidencePackage,
): SuggestionCandidate {
  const navigateUrl = testCase.steps.find((step) => step.kind === "navigate")?.url ?? snapshot.targetUrl;
  const path = safePath(navigateUrl);
  const area = path === "/" ? "Home" : (path.split("/").filter(Boolean)[0] ?? "Home");
  const evidenceRefs = (evidence?.items ?? [])
    .filter((item) => item.source === path)
    .map((item) => item.evidenceId)
    .slice(0, 5);

  return {
    testCase,
    area: titleCase(area),
    journey: testCase.title,
    persona: null,
    testType: testCase.executionMode === "state_changing" ? "form" : "smoke",
    priority: testCase.riskLevel,
    expectedResult:
      testCase.executionMode === "state_changing"
        ? "The form submits and the browser stays on an approved domain."
        : `${path} loads and still shows its known title.`,
    fixtureRefs: [],
    evidenceRefs,
    rationale: "Derived deterministically from what discovery observed — no model involved.",
    confidence: 1,
    source: "rule",
  };
}

function routesFor(snapshot: DiscoverySnapshot): string[] {
  return [
    ...new Set([snapshot.targetUrl, ...snapshot.visitedUrls, ...snapshot.pages.map((page) => page.url)]),
  ];
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
