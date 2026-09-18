import type { ApplicationTestMap, UserJourney } from "../../domain/index.js";

export type RegressionRecommendation = {
  journeyId: string;
  journeyName: string;
  areaName: string;
  riskLevel: "low" | "medium" | "high";
  reason: string;
};

/**
 * Extension seam for a later signal source (e.g. Git/PR change-impact
 * analysis, a real defect tracker, CI flake detection) — the default
 * recommendation service only ever consults deterministic data already on
 * the map/journey (risk level, last run outcome/time), never a model, but
 * a richer source can be plugged in here without changing how
 * recommendations are ranked or presented.
 */
export interface RegressionSignalSource {
  /** Extra reasons to recommend a journey, keyed by journey id. Empty/absent is fine — deterministic rules still apply. */
  additionalReasons(map: ApplicationTestMap): Promise<Map<string, string>>;
}

export const noAdditionalSignals: RegressionSignalSource = {
  additionalReasons: async () => new Map(),
};

export type RecommendationConfig = {
  /** A journey not run within this many days is recommended as "stale." */
  staleAfterDays: number;
};

export const defaultRecommendationConfig: RecommendationConfig = { staleAfterDays: 14 };

function daysSince(isoTimestamp: string, now: Date): number {
  return (now.getTime() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60 * 24);
}

function deterministicReason(
  journey: UserJourney,
  config: RecommendationConfig,
  now: Date,
): string | undefined {
  if (journey.lastRunOutcome === "failed") {
    return "Last run failed";
  }
  if (journey.lastRunOutcome === "flaky") {
    return "Recently flaky";
  }
  if (journey.lastRunOutcome === "blocked") {
    return "Last run was blocked by policy";
  }
  if (!journey.lastRunAt) {
    return "Never run";
  }
  const ageDays = daysSince(journey.lastRunAt, now);
  if (ageDays >= config.staleAfterDays) {
    return `Not run in ${Math.floor(ageDays)} days`;
  }
  return undefined;
}

/**
 * Deterministic regression recommendations only — risk level plus recent
 * outcome/staleness. Ranked by risk (high first), then by whether a
 * defect/flake reason exists, so the most consequential, most suspect
 * journeys surface first. `signalSource` is the seam for a future
 * change-impact analyzer; passing `noAdditionalSignals` (the default)
 * keeps this fully deterministic today.
 */
export async function recommendRegressionJourneys(
  map: ApplicationTestMap,
  config: RecommendationConfig = defaultRecommendationConfig,
  signalSource: RegressionSignalSource = noAdditionalSignals,
  now: Date = new Date(),
): Promise<RegressionRecommendation[]> {
  const additionalReasons = await signalSource.additionalReasons(map);
  const riskOrder: Record<"high" | "medium" | "low", number> = { high: 0, medium: 1, low: 2 };

  const recommendations: RegressionRecommendation[] = [];
  for (const area of map.areas) {
    for (const journey of area.journeys) {
      if (journey.status !== "approved") {
        continue;
      }
      const reason = additionalReasons.get(journey.id) ?? deterministicReason(journey, config, now);
      if (!reason) {
        continue;
      }
      recommendations.push({
        journeyId: journey.id,
        journeyName: journey.name,
        areaName: area.name,
        riskLevel: area.riskLevel,
        reason,
      });
    }
  }

  return recommendations.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);
}
