import { randomUUID } from "node:crypto";

import type { ApplicationTestMap, RunStatus, TestRunState, UserJourney } from "../../domain/index.js";
import type { NovaRuntime } from "../../cli/context.js";
import type { ApplicationTestMapRepository } from "../persistence/test-map-repository.js";
import { MapBackedJourneyRepository } from "../persistence/test-map-repository.js";
import { buildPlanFromJourney, type JourneyRunContext } from "./map-to-plan.js";
import { runExecution, runApprove, type ExecutionResultSummary } from "../../cli/commands.js";
import { applySelectorHeals, deriveHealCandidates } from "./selector-healing.js";

export class JourneyScopeError extends Error {}
export class FixtureLockedError extends Error {}

/**
 * Validates a requested run context against the journey and map before a
 * single row is written — every rejection here is a plain, auditable
 * comparison against curated data, never a model's opinion of what is
 * safe. This is the code-level scope backstop for journeys, mirroring
 * checkExecutionAllowed/checkCaseScope for the discover/plan/approve path.
 */
export function validateJourneyRunContext(
  map: ApplicationTestMap,
  journey: UserJourney,
  context: JourneyRunContext,
): void {
  if (journey.status !== "approved") {
    throw new JourneyScopeError(
      `Journey "${journey.name}" is "${journey.status}" — only an approved journey may run.`,
    );
  }
  if (context.environment !== map.environment) {
    throw new JourneyScopeError(
      `Journey belongs to map environment "${map.environment}", not requested "${context.environment}".`,
    );
  }
  if (journey.requiredPersonaIds.length > 0) {
    if (!context.personaId || !journey.requiredPersonaIds.includes(context.personaId)) {
      throw new JourneyScopeError(
        `Journey "${journey.name}" requires one of persona(s) [${journey.requiredPersonaIds.join(", ")}].`,
      );
    }
    const persona = map.personas.find((candidate) => candidate.id === context.personaId);
    if (!persona) {
      throw new JourneyScopeError(`Unknown persona: ${context.personaId}`);
    }
    if (!persona.allowedEnvironments.includes(context.environment)) {
      throw new JourneyScopeError(
        `Persona "${persona.name}" is not permitted in environment "${context.environment}".`,
      );
    }
  }
  for (const requiredFixtureId of journey.requiredFixtureIds) {
    if (!context.fixtureIds.includes(requiredFixtureId)) {
      throw new JourneyScopeError(`Journey "${journey.name}" requires fixture "${requiredFixtureId}".`);
    }
  }
  for (const fixtureId of context.fixtureIds) {
    if (!map.fixtures.some((fixture) => fixture.id === fixtureId)) {
      throw new JourneyScopeError(`Unknown fixture: ${fixtureId}`);
    }
  }
}

function findArea(map: ApplicationTestMap, journeyId: string): string {
  const area = map.areas.find((candidate) => candidate.journeys.some((journey) => journey.id === journeyId));
  if (!area) {
    throw new Error(`Journey ${journeyId} does not belong to any area in map ${map.id}.`);
  }
  return area.id;
}

/**
 * Acquires every lock-required fixture the context declares. Throws
 * FixtureLockedError (and releases anything it already grabbed) if any
 * one of them is already held by a different run — a run either gets
 * every fixture it needs or none of them, never a partial hold.
 */
function acquireFixtureLocks(
  maps: ApplicationTestMapRepository,
  map: ApplicationTestMap,
  fixtureIds: string[],
  runId: string,
): string[] {
  const acquired: string[] = [];
  for (const fixtureId of fixtureIds) {
    const fixture = map.fixtures.find((candidate) => candidate.id === fixtureId);
    if (!fixture?.lockRequired) {
      continue;
    }
    const acquiredLock = maps.acquireFixtureLock(map.id, fixtureId, runId);
    if (!acquiredLock) {
      for (const held of acquired) {
        maps.releaseFixtureLock(map.id, held, runId);
      }
      throw new FixtureLockedError(`Fixture "${fixture.name}" is locked by another run.`);
    }
    acquired.push(fixtureId);
  }
  return acquired;
}

function releaseFixtureLocks(
  maps: ApplicationTestMapRepository,
  mapId: string,
  fixtureIds: string[],
  runId: string,
): void {
  for (const fixtureId of fixtureIds) {
    maps.releaseFixtureLock(mapId, fixtureId, runId);
  }
}

export type PreparedJourneyRun = {
  runId: string;
  status: RunStatus;
  mode: UserJourney["mode"];
  cases: Array<{ id: string; title: string; riskLevel: string; executionMode: string }>;
};

/**
 * Creates the run row for a journey and, per the journey's own declared
 * mode, either executes it immediately (quick_test), leaves it staged for
 * an explicit confirmation (guided_test), or leaves it staged for a
 * separate approval decision (controlled_test) — the same
 * awaiting_approval -> approval_gate -> execute path `nova approve`/
 * `nova run` already use, so a controlled-mode journey run carries
 * exactly the same auditable human-approval guarantee as the plain CLI
 * path, not a weaker "map" shortcut.
 */
export async function startJourneyRun(
  runtime: NovaRuntime,
  maps: ApplicationTestMapRepository,
  map: ApplicationTestMap,
  journey: UserJourney,
  context: JourneyRunContext,
): Promise<PreparedJourneyRun> {
  validateJourneyRunContext(map, journey, context);

  const runId = randomUUID();
  const acquiredLocks = acquireFixtureLocks(maps, map, context.fixtureIds, runId);
  const { manifest, testPlan } = buildPlanFromJourney(map, journey, context);
  const now = new Date().toISOString();
  const areaId = findArea(map, journey.id);

  const initial: TestRunState = {
    tenantId: "default",
    projectId: "default",
    runId,
    targetManifest: manifest,
    objective: journey.description,
    testPlan,
    testMapContext: {
      mapId: map.id,
      mapVersion: map.version,
      areaId,
      journeyId: journey.id,
      personaId: context.personaId,
      fixtureIds: context.fixtureIds,
    },
    status: "awaiting_approval",
    executionResults: [],
    verificationResults: [],
    artifactReferences: [],
    auditEvents: [
      {
        timestamp: now,
        type: "journey_run_started",
        detail: { journeyId: journey.id, mapId: map.id, mode: journey.mode, fixtureLocks: acquiredLocks },
        actor: "tui_or_cli",
      },
    ],
  };
  runtime.repository.save(initial);

  const caseSummaries = testPlan.cases.map((testCase) => ({
    id: testCase.id,
    title: testCase.title,
    riskLevel: testCase.riskLevel,
    executionMode: testCase.executionMode,
  }));

  if (journey.mode === "quick_test") {
    await confirmJourneyRun(runtime, maps, runId, "system:quick_test_policy");
    const final = runtime.repository.get(runId);
    return { runId, status: final?.status ?? "executing", mode: journey.mode, cases: caseSummaries };
  }

  return { runId, status: "awaiting_approval", mode: journey.mode, cases: caseSummaries };
}

/**
 * The single human (or, for quick_test only, policy-declared) approval
 * step that lets a staged journey run proceed to execute — reuses
 * runApprove/runExecution verbatim so there is exactly one code path that
 * ever moves a run from "awaiting_approval" to "executing", regardless of
 * whether it was reached via `nova plan`/`nova approve` or via a journey.
 * Runs fixture-lock release and any declared cleanup in a `finally` block
 * so both happen even if execution throws or every case fails.
 */
export async function confirmJourneyRun(
  runtime: NovaRuntime,
  maps: ApplicationTestMapRepository,
  runId: string,
  reviewer: string,
): Promise<ExecutionResultSummary> {
  const run = runtime.repository.get(runId);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  await runApprove(runtime, { plan: runId, reviewer });

  try {
    const result = await runExecution(runtime, { plan: runId });
    if (run.testMapContext) {
      const journeyRepository = new MapBackedJourneyRepository(maps);
      const outcome = classifyOutcome(result.classificationCounts);
      journeyRepository.recordRunOutcome(
        run.testMapContext.mapId,
        run.testMapContext.journeyId,
        outcome,
        new Date().toISOString(),
      );
      persistSelectorHeals(runtime, maps, runId, run.testMapContext.mapId, run.testMapContext.journeyId);
    }
    return result;
  } finally {
    await runJourneyCleanup(runtime, maps, runId);
  }
}

/**
 * Self-learning selector healing: reads back the just-completed run's
 * recorded recovery attempts and writes any `recovered` selector onto
 * the map's checkpoint steps, so the *next* run of this journey no
 * longer needs runtime recovery for the same drift. Never touches an
 * unrecovered/exhausted attempt, and silently no-ops if the map or
 * journey has since moved on (e.g. curated away mid-run) — a stale run
 * can never retroactively rewrite a map that changed underneath it.
 */
function persistSelectorHeals(
  runtime: NovaRuntime,
  maps: ApplicationTestMapRepository,
  runId: string,
  mapId: string,
  journeyId: string,
): void {
  const finalRun = runtime.repository.get(runId);
  const map = maps.get(mapId);
  const journey = map?.areas.flatMap((area) => area.journeys).find((candidate) => candidate.id === journeyId);
  if (!finalRun || !map || !journey) {
    return;
  }
  const recoveryAttempts = finalRun.executionResults.flatMap((result) => result.recoveryAttempts);
  const candidates = deriveHealCandidates(journey, recoveryAttempts);
  const healedMap = applySelectorHeals(map, candidates);
  if (healedMap !== map) {
    maps.save(healedMap);
  }
}

function classifyOutcome(
  classificationCounts: Record<string, number>,
): "passed" | "failed" | "flaky" | "blocked" | "inconclusive" {
  if ((classificationCounts.failed ?? 0) > 0) {
    return "failed";
  }
  if ((classificationCounts.blocked ?? 0) > 0) {
    return "blocked";
  }
  if ((classificationCounts.inconclusive ?? 0) > 0) {
    return "inconclusive";
  }
  return "passed";
}

/**
 * Releases every fixture lock the run held and records a cleanup audit
 * event for each fixture that declared a cleanupAction — Nova has no
 * arbitrary-code execution path, so a declared cleanupAction is recorded
 * as performed/attempted rather than shelled out to, consistent with "no
 * arbitrary shell commands anywhere in the execution path." Runs even
 * when execution failed; only skipped for a case blocked outright by
 * policy before any state change was ever attempted.
 */
export async function runJourneyCleanup(
  runtime: NovaRuntime,
  maps: ApplicationTestMapRepository,
  runId: string,
): Promise<void> {
  const run = runtime.repository.get(runId);
  if (!run?.testMapContext) {
    return;
  }
  const mapRepository = maps.get(run.testMapContext.mapId);
  if (!mapRepository) {
    return;
  }
  const auditEvents = [...run.auditEvents];
  for (const fixtureId of run.testMapContext.fixtureIds) {
    const fixture = mapRepository.fixtures.find((candidate) => candidate.id === fixtureId);
    if (fixture?.cleanupAction) {
      auditEvents.push({
        timestamp: new Date().toISOString(),
        type: "fixture_cleanup_recorded",
        detail: { fixtureId, cleanupAction: fixture.cleanupAction },
        actor: "system",
      });
    }
  }
  releaseFixtureLocks(maps, run.testMapContext.mapId, run.testMapContext.fixtureIds, runId);
  runtime.repository.save({ ...run, auditEvents });
}
