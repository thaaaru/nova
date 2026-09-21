import { discoverApplication, newRunId } from "../browser/discover.js";
import type {
  ApplicationTestMap,
  ApplicationTestMapEnvironment,
  Assertion,
  TestStep,
  UserJourney,
} from "../../domain/index.js";
import type { NovaRuntime } from "../../cli/context.js";
import { deriveApplicationName } from "./discover-input-rules.js";
import {
  MapBackedFixtureRepository,
  MapBackedJourneyRepository,
  MapBackedPersonaRepository,
} from "../persistence/test-map-repository.js";
import { buildDraftMapFromDiscovery } from "./discovery-to-map.js";
import type { JourneyRunContext } from "./map-to-plan.js";
import { confirmJourneyRun, startJourneyRun, type PreparedJourneyRun } from "./journey-run-service.js";
import { matchNaturalLanguageRequest, type NaturalLanguageMatch } from "./nl-match-service.js";
import {
  defaultRecommendationConfig,
  noAdditionalSignals,
  recommendRegressionJourneys,
  type RecommendationConfig,
  type RegressionRecommendation,
} from "./recommendation-service.js";

/**
 * The single Application Test Map service surface — `nova map`/`nova
 * area`/`nova journey`/`nova recommendations` CLI commands, the TUI, and
 * (later) MCP tools all call these functions, exactly the same pattern
 * `src/cli/commands.ts` already establishes for the discover/plan/
 * approve/run/report path: no business logic is ever duplicated in a
 * presentation layer, and no function here writes to stdout.
 */

export type DiscoverMapResult = { map: ApplicationTestMap };

export async function discoverMap(
  runtime: NovaRuntime,
  options: {
    target: string;
    /**
     * When omitted, Nova identifies the application from what discovery
     * actually finds — via `runtime.appIdentifier` (DeepSeek) if
     * configured, otherwise a deterministic URL-hostname guess, exactly
     * the fallback the CLI/TUI used to force upfront. Either way the
     * resulting map always has a real name; this never leaves it blank.
     */
    applicationName?: string;
    environment: ApplicationTestMapEnvironment;
    storageStatePath?: string;
    headless?: boolean;
    onProgress?: (message: string) => void;
  },
): Promise<DiscoverMapResult> {
  const allowedDomains = [new URL(options.target).hostname];
  const runId = newRunId();
  const snapshot = await discoverApplication({
    runId,
    manifest: {
      targetId: allowedDomains[0],
      baseUrl: options.target,
      allowedDomains,
      environment: options.environment,
      description: `Discovery for Application Test Map "${options.applicationName ?? allowedDomains[0]}"`,
      runExecutionMode: "observe",
      storageStatePath: options.storageStatePath,
      createdAt: new Date().toISOString(),
    },
    headless: options.headless ?? runtime.config.headless,
    onProgress: options.onProgress,
  });
  const applicationName = await resolveApplicationName(
    runtime,
    options.target,
    options.applicationName,
    snapshot,
  );
  const map = buildDraftMapFromDiscovery(snapshot, {
    applicationName,
    environment: options.environment,
    allowedDomains,
  });
  if (options.storageStatePath) {
    map.approvedScope.storageStatePath = options.storageStatePath;
  }
  runtime.testMaps.save(map);
  return { map };
}

/**
 * A user-supplied name always wins. Otherwise, prefers the LLM identifier
 * (real page content — titles, forms, button/link text) over the
 * deterministic URL-hostname guess; a failed/unavailable LLM call falls
 * straight back to that guess rather than failing discovery outright,
 * since naming is display metadata, never a policy or safety decision.
 */
export async function resolveApplicationName(
  runtime: NovaRuntime,
  target: string,
  provided: string | undefined,
  snapshot: Awaited<ReturnType<typeof discoverApplication>>,
): Promise<string> {
  if (provided && provided.trim().length > 0) {
    return provided.trim();
  }
  if (runtime.appIdentifier) {
    try {
      const identity = await runtime.appIdentifier(snapshot);
      if (identity.name.trim().length > 0) {
        return identity.name.trim();
      }
    } catch {
      // Fall through to the deterministic guess below — naming never blocks discovery.
    }
  }
  return deriveApplicationName(target) ?? target;
}

export function listMaps(runtime: NovaRuntime): ApplicationTestMap[] {
  return runtime.testMaps.list();
}

export function getMap(runtime: NovaRuntime, mapId: string): ApplicationTestMap | undefined {
  return runtime.testMaps.get(mapId);
}

export function listAreas(runtime: NovaRuntime, mapId: string): ApplicationTestMap["areas"] {
  const map = requireMap(runtime, mapId);
  return map.areas;
}

export function listJourneys(runtime: NovaRuntime, mapId: string, areaId?: string): UserJourney[] {
  return new MapBackedJourneyRepository(runtime.testMaps).list(mapId, areaId);
}

export function approveJourney(runtime: NovaRuntime, mapId: string, journeyId: string): UserJourney {
  return new MapBackedJourneyRepository(runtime.testMaps).setStatus(mapId, journeyId, "approved");
}

/**
 * Writes deterministic steps/assertions onto one draft journey checkpoint
 * — the curation step a QA engineer performs on a "describe a test" or
 * discovery-drafted guided_test outline before it can ever be approved to
 * run. Never invents a step/assertion itself; the caller supplies the
 * fully-formed, schema-valid arrays (validated by TestStepSchema /
 * AssertionSchema at the CLI boundary before this is called).
 */
export function curateCheckpoint(
  runtime: NovaRuntime,
  mapId: string,
  journeyId: string,
  checkpointId: string,
  steps: TestStep[],
  assertions: Assertion[],
): UserJourney {
  return new MapBackedJourneyRepository(runtime.testMaps).setCheckpointSteps(
    mapId,
    journeyId,
    checkpointId,
    steps,
    assertions,
  );
}

export type RunJourneyOptions = {
  mapId: string;
  journeyId: string;
  environment: string;
  personaId?: string;
  fixtureIds?: string[];
};

export async function runJourney(
  runtime: NovaRuntime,
  options: RunJourneyOptions,
): Promise<PreparedJourneyRun> {
  const map = requireMap(runtime, options.mapId);
  const journey = new MapBackedJourneyRepository(runtime.testMaps).get(options.mapId, options.journeyId);
  if (!journey) {
    throw new Error(`Unknown journey: ${options.journeyId}`);
  }
  const context: JourneyRunContext = {
    environment: options.environment,
    personaId: options.personaId,
    fixtureIds: options.fixtureIds ?? [],
  };
  return startJourneyRun(runtime, runtime.testMaps, map, journey, context);
}

/**
 * The explicit human confirmation step for a `guided_test`/`controlled_test`
 * journey run staged by `runJourney` — reviewer identifies the real
 * engineer who reviewed the pre-run summary (or, for controlled_test,
 * the reviewer approving a submitted plan).
 */
export async function confirmRun(runtime: NovaRuntime, runId: string, reviewer: string) {
  return confirmJourneyRun(runtime, runtime.testMaps, runId, reviewer);
}

export function listPersonas(runtime: NovaRuntime, mapId: string) {
  return new MapBackedPersonaRepository(runtime.testMaps).list(mapId);
}

export function listFixtures(runtime: NovaRuntime, mapId: string) {
  return new MapBackedFixtureRepository(runtime.testMaps).list(mapId);
}

export async function recommendations(
  runtime: NovaRuntime,
  mapId: string,
  config: RecommendationConfig = defaultRecommendationConfig,
): Promise<RegressionRecommendation[]> {
  const map = requireMap(runtime, mapId);
  return recommendRegressionJourneys(map, config, noAdditionalSignals);
}

export function describeTest(runtime: NovaRuntime, mapId: string, requestText: string): NaturalLanguageMatch {
  const map = requireMap(runtime, mapId);
  return matchNaturalLanguageRequest(map, requestText);
}

function requireMap(runtime: NovaRuntime, mapId: string): ApplicationTestMap {
  const map = runtime.testMaps.get(mapId);
  if (!map) {
    throw new Error(`Unknown application test map: ${mapId}`);
  }
  return map;
}
