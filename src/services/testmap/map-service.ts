import { discoverApplication, newRunId } from "../browser/discover.js";
import type { ApplicationTestMap, ApplicationTestMapEnvironment, UserJourney } from "../../domain/index.js";
import type { NovaRuntime } from "../../cli/context.js";
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
    applicationName: string;
    environment: ApplicationTestMapEnvironment;
    headless?: boolean;
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
      description: `Discovery for Application Test Map "${options.applicationName}"`,
      runExecutionMode: "observe",
      createdAt: new Date().toISOString(),
    },
    headless: options.headless ?? runtime.config.headless,
  });
  const map = buildDraftMapFromDiscovery(snapshot, {
    applicationName: options.applicationName,
    environment: options.environment,
    allowedDomains,
  });
  runtime.testMaps.save(map);
  return { map };
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
