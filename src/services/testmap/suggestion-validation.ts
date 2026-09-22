import type {
  ApplicationEvidencePackage,
  DiscoverySnapshot,
  SideEffectClass,
  SuggestedTestCase,
  SuggestedTestPlan,
  SuggestionRejection,
  TargetManifest,
  TestCase,
} from "../../domain/index.js";
import { SuggestedTestCaseSchema } from "../../domain/index.js";
import { checkCaseScope, isDomainAllowed } from "../policy/scope-policy.js";
import { sha256Of } from "../hash.js";

/**
 * The deterministic gate every suggested test case passes before a human
 * ever sees it, whether it came from the rule pack or from a model. None
 * of these checks consults an LLM, and none of them can be satisfied by
 * assertion — each is a membership or structural test against what
 * discovery actually observed and what the manifest actually allows.
 *
 * A candidate that fails any check is rejected with the check that
 * rejected it, so the approval page can show the reviewer exactly what
 * Nova refused to suggest and why.
 */

export type SuggestionCandidate = Omit<SuggestedTestCase, "id" | "sideEffect" | "requiredApprovalLevel">;

export type ValidationContext = {
  planId: string;
  manifest: TargetManifest;
  snapshot: DiscoverySnapshot;
  evidence?: ApplicationEvidencePackage;
  knownPersonaIds?: string[];
  knownFixtureIds?: string[];
};

export function validateSuggestions(
  candidates: SuggestionCandidate[],
  context: ValidationContext,
): SuggestedTestPlan {
  const accepted: SuggestedTestCase[] = [];
  const rejected: SuggestionRejection[] = [];
  const seenFingerprints = new Set<string>();
  const knownRoutes = new Set(context.snapshot.visitedUrls.map(normalizeUrl));
  for (const page of context.snapshot.pages) {
    knownRoutes.add(normalizeUrl(page.url));
  }
  knownRoutes.add(normalizeUrl(context.manifest.baseUrl));
  const knownEvidence = new Set((context.evidence?.items ?? []).map((item) => item.evidenceId));
  const knownPersonas = new Set(context.knownPersonaIds ?? []);
  const knownFixtures = new Set(context.knownFixtureIds ?? []);

  candidates.forEach((candidate, index) => {
    const candidateId = `${context.planId}-c${index + 1}`;
    const reject = (check: SuggestionRejection["check"], reason: string): void => {
      rejected.push({ candidateId, title: candidate.testCase.title, check, reason });
    };

    const executability = checkExecutability(candidate.testCase);
    if (executability) {
      reject("executability", executability);
      return;
    }

    const scope = checkCaseScope(candidate.testCase, context.manifest);
    if (!scope.ok) {
      reject("scope", `Case declares a domain outside the manifest: ${JSON.stringify(scope.violation)}`);
      return;
    }

    const offTarget = candidate.testCase.steps.find(
      (step) => step.url !== undefined && !isDomainAllowed(step.url, context.manifest),
    );
    if (offTarget) {
      reject("target", `Step navigates outside the approved target: ${offTarget.url}`);
      return;
    }

    const unknownRoute = candidate.testCase.steps.find(
      (step) => step.url !== undefined && !knownRoutes.has(normalizeUrl(step.url)),
    );
    if (unknownRoute) {
      reject("route_existence", `Route was never observed during discovery: ${unknownRoute.url}`);
      return;
    }

    if (candidate.persona !== null && knownPersonas.size > 0 && !knownPersonas.has(candidate.persona)) {
      reject("persona_existence", `Unknown persona: ${candidate.persona}`);
      return;
    }

    const missingFixture = candidate.fixtureRefs.find((fixture) => !knownFixtures.has(fixture));
    if (missingFixture) {
      reject("fixture_availability", `Unknown fixture: ${missingFixture}`);
      return;
    }

    const sideEffect = classifySideEffect(candidate.testCase);
    const policyFailure = checkPolicy(candidate.testCase, sideEffect, context.manifest);
    if (policyFailure) {
      reject("policy", policyFailure);
      return;
    }

    const unknownEvidence = candidate.evidenceRefs.filter((ref) => !knownEvidence.has(ref));
    if (context.evidence && unknownEvidence.length > 0) {
      reject(
        "evidence_traceability",
        `Cites evidence that was never collected: ${unknownEvidence.join(", ")}`,
      );
      return;
    }
    if (context.evidence && candidate.source !== "rule" && candidate.evidenceRefs.length === 0) {
      reject("evidence_traceability", "Model-suggested case cites no evidence.");
      return;
    }

    const fingerprint = sha256Of({
      steps: candidate.testCase.steps,
      assertions: candidate.testCase.assertions,
    });
    if (seenFingerprints.has(fingerprint)) {
      reject("duplicate", "Identical steps and assertions to an already-accepted case.");
      return;
    }
    seenFingerprints.add(fingerprint);

    accepted.push(
      SuggestedTestCaseSchema.parse({
        ...candidate,
        id: candidateId,
        testCase: { ...candidate.testCase, id: candidateId },
        sideEffect,
        requiredApprovalLevel: requiredApprovalLevel(candidate.testCase, sideEffect),
      }),
    );
  });

  return { planId: context.planId, accepted, rejected };
}

/** A case must be runnable as written: real steps, real assertions, and a locator for every interaction. */
function checkExecutability(testCase: TestCase): string | undefined {
  if (testCase.steps.length === 0) {
    return "Case has no steps.";
  }
  if (testCase.assertions.length === 0) {
    return "Case has no assertions.";
  }
  for (const [index, step] of testCase.steps.entries()) {
    if (step.kind === "navigate" && !step.url) {
      return `Step ${index + 1} navigates with no URL.`;
    }
    if (
      ["click", "fill", "select", "check", "waitForSelector"].includes(step.kind) &&
      !step.selector &&
      !(step.role && step.name)
    ) {
      return `Step ${index + 1} (${step.kind}) has no selector or role/name locator.`;
    }
    if (step.kind === "fill" && step.value === undefined) {
      return `Step ${index + 1} fills nothing.`;
    }
  }
  return undefined;
}

/**
 * Side effects are read off the case's own steps, never taken from a
 * suggestion's own claim. A read_only case is "none" by construction; a
 * state_changing one is classified by the strongest verb its step
 * locators and title reveal, and high-risk mutations are treated as
 * irreversible unless proven otherwise.
 */
export function classifySideEffect(testCase: TestCase): SideEffectClass {
  if (testCase.executionMode === "read_only") {
    return "none";
  }
  const haystack = [
    testCase.title,
    ...testCase.steps.map((step) => `${step.selector ?? ""} ${step.name ?? ""} ${step.value ?? ""}`),
  ]
    .join(" ")
    .toLowerCase();
  if (/\b(delete|remove|destroy|purge|cancel|revoke)\b/.test(haystack)) {
    return testCase.riskLevel === "high" ? "irreversible" : "deletes_data";
  }
  if (/\b(update|edit|modify|change|rename|approve|publish)\b/.test(haystack)) {
    return "modifies_data";
  }
  return "creates_data";
}

/** High-risk or irreversible work needs an elevated approval; everything else is a standard review. */
export function requiredApprovalLevel(
  testCase: TestCase,
  sideEffect: SideEffectClass,
): "standard" | "elevated" {
  if (sideEffect === "irreversible" || sideEffect === "deletes_data" || testCase.riskLevel === "high") {
    return "elevated";
  }
  return "standard";
}

/**
 * The same ceilings `scope-policy.checkExecutionAllowed` enforces at
 * execution time, applied at suggestion time so a case that could never
 * legally run is never even offered for approval.
 */
function checkPolicy(
  testCase: TestCase,
  sideEffect: SideEffectClass,
  manifest: TargetManifest,
): string | undefined {
  if (manifest.runExecutionMode === "observe" && testCase.executionMode === "state_changing") {
    return "Manifest is in observe mode; state-changing cases are forbidden.";
  }
  if (manifest.runExecutionMode !== "destructive_test" && sideEffect === "irreversible") {
    return "Irreversible cases require runExecutionMode=destructive_test.";
  }
  if (manifest.runExecutionMode !== "destructive_test" && testCase.riskLevel === "high") {
    return "High-risk cases require runExecutionMode=destructive_test.";
  }
  return undefined;
}

/** Trailing-slash- and hash-insensitive comparison, so "/x" and "/x/" are the same discovered route. */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return url;
  }
}
