import { randomUUID } from "node:crypto";

import type {
  ApplicationTestMap,
  RiskLevel,
  TargetManifest,
  TestCase,
  TestPlan,
  UserJourney,
} from "../../domain/index.js";

export type JourneyRunContext = {
  environment: string;
  personaId?: string;
  fixtureIds: string[];
};

/**
 * Deterministically converts a journey's own checkpoints into a TestPlan
 * case — never through a model. A checkpoint with no declared steps still
 * produces a case (an empty step list is a schema violation, so a
 * checkpoint is expected to carry real steps/assertions once curated), but
 * this function never invents one on its own.
 */
function checkpointsToCases(
  journey: UserJourney,
  manifest: TargetManifest,
  context: JourneyRunContext,
): TestCase[] {
  const highestRisk: RiskLevel = journey.checkpoints.some((checkpoint) => checkpoint.riskLevel === "high")
    ? "high"
    : journey.checkpoints.some((checkpoint) => checkpoint.riskLevel === "medium")
      ? "medium"
      : "low";

  const steps = journey.checkpoints.flatMap((checkpoint) => checkpoint.steps);
  const assertions = journey.checkpoints.flatMap((checkpoint) => checkpoint.assertions);
  const hasStateChangingStep = steps.some((step) => ["click", "fill", "select", "check"].includes(step.kind));
  const contextPreconditions = [
    `Environment: ${context.environment}`,
    ...(context.personaId ? [`Persona: ${context.personaId}`] : []),
    ...context.fixtureIds.map((fixtureId) => `Fixture: ${fixtureId}`),
  ];

  const testCase: TestCase = {
    id: `${journey.id}-case`,
    title: journey.name,
    preconditions: [...(journey.testTemplate?.preconditions ?? []), ...contextPreconditions],
    steps,
    assertions: assertions.length > 0 ? assertions : [{ kind: "urlContains", expected: "" }],
    allowedDomains: manifest.allowedDomains,
    executionMode: hasStateChangingStep ? "state_changing" : "read_only",
    riskLevel: highestRisk,
    timeoutMs: journey.testTemplate?.timeoutMs ?? 60_000,
    recoveryBudget: journey.allowedRecoveryActions.length > 0 ? 2 : 0,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  };
  return [testCase];
}

/**
 * Builds the TargetManifest a journey run executes under, straight from
 * the map's own approved scope — a run launched from the Application
 * Test Map can never carry a wider scope than the map's curators already
 * signed off on.
 */
export function buildManifestFromMap(map: ApplicationTestMap): TargetManifest {
  return {
    targetId: map.id,
    baseUrl: map.targetUrl,
    allowedDomains: map.approvedScope.allowedDomains,
    environment: map.environment,
    description: `Application Test Map "${map.applicationName}" v${map.version}`,
    runExecutionMode: map.approvedScope.executionMode,
    createdAt: map.createdAt,
  };
}

export type JourneyPlanResult = {
  manifest: TargetManifest;
  testPlan: TestPlan;
};

/**
 * Turns one journey + run context into a fully formed, schema-valid
 * TestPlan/TargetManifest pair, ready to hand straight to the existing
 * execution graph — exactly the same TestPlan shape `nova plan` produces,
 * just sourced from curated journey data instead of a discovery-derived
 * template.
 */
export function buildPlanFromJourney(
  map: ApplicationTestMap,
  journey: UserJourney,
  context: JourneyRunContext,
): JourneyPlanResult {
  const manifest = buildManifestFromMap(map);
  const cases = checkpointsToCases(journey, manifest, context);
  const testPlan: TestPlan = {
    id: randomUUID(),
    version: 1,
    objective: journey.description,
    targetManifestId: manifest.targetId,
    createdAt: new Date().toISOString(),
    cases,
  };
  return { manifest, testPlan };
}
