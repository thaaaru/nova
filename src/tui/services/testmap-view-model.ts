import type {
  ApplicationArea,
  ApplicationTestMap,
  ExecutionModeLabel,
  UserJourney,
} from "../../domain/index.js";
import { POLICY_MODE_LABEL } from "./view-model.js";

/**
 * The seven numbered options on the Application Test Map home menu — the
 * TUI's single entry point into the map-driven product flow. IDs are the
 * screen-routing keys App.tsx switches on; numbers/labels are exactly the
 * product spec's wording so operators can drive the menu by digit key.
 */
export type MapHomeMenuOptionId =
  "test-area" | "describe-test" | "recommendations" | "explore-map" | "failures" | "reports" | "command-mode";

export const MAP_HOME_MENU_ITEMS: Array<{ id: MapHomeMenuOptionId; number: number; label: string }> = [
  { id: "test-area", number: 1, label: "Test an application area" },
  { id: "describe-test", number: 2, label: "Describe a test" },
  { id: "recommendations", number: 3, label: "Run recommended regression tests" },
  { id: "explore-map", number: 4, label: "Explore and update application map" },
  { id: "failures", number: 5, label: "Review failures and recoveries" },
  { id: "reports", number: 6, label: "Open recent reports" },
  { id: "command-mode", number: 7, label: "Advanced command mode" },
];

/**
 * Picks the "active" map for the home menu: the most recently updated one.
 * `ApplicationTestMapRepository.list()` already orders by `updatedAt`
 * descending, but this stays defensive so callers passing an unordered
 * array (e.g. a test fixture array) still get the right answer.
 */
export function selectActiveMap(maps: ApplicationTestMap[]): ApplicationTestMap | undefined {
  if (maps.length === 0) {
    return undefined;
  }
  return [...maps].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export type MapHomeSummary = {
  hasMap: boolean;
  noMapMessage?: string;
  applicationName?: string;
  environment?: string;
  latestRunOutcome?: NonNullable<UserJourney["lastRunOutcome"]>;
  approvedJourneyCount: number;
  journeysNeedingReviewCount: number;
  executionModeLabel: string;
};

/**
 * Everything the new Home menu's summary panel renders, derived once from
 * the active map alone — no run repository access needed, since every
 * figure here (approved/draft counts, latest outcome, policy mode) is
 * already carried on the map's own journeys/approvedScope.
 */
export function buildMapHomeSummary(map: ApplicationTestMap | undefined): MapHomeSummary {
  if (!map) {
    return {
      hasMap: false,
      noMapMessage: "No application test map yet — run `nova map discover` first.",
      approvedJourneyCount: 0,
      journeysNeedingReviewCount: 0,
      executionModeLabel: "—",
    };
  }

  const journeys = map.areas.flatMap((area) => area.journeys);
  const approvedJourneyCount = journeys.filter((journey) => journey.status === "approved").length;
  const journeysNeedingReviewCount = journeys.filter((journey) => journey.status === "draft").length;

  const mostRecentlyRun = journeys
    .filter((journey): journey is UserJourney & { lastRunAt: string } => Boolean(journey.lastRunAt))
    .sort((a, b) => b.lastRunAt.localeCompare(a.lastRunAt))[0];

  return {
    hasMap: true,
    applicationName: map.applicationName,
    environment: map.environment,
    latestRunOutcome: mostRecentlyRun?.lastRunOutcome,
    approvedJourneyCount,
    journeysNeedingReviewCount,
    executionModeLabel: POLICY_MODE_LABEL[map.approvedScope.executionMode] ?? map.approvedScope.executionMode,
  };
}

export type AreaSummary = ApplicationArea & {
  approvedJourneyCount: number;
  recentFailureCount: number;
};

/**
 * Area-select screen rows: approved-journey and recent-failure counts are
 * computed here from the area's own already-fetched journeys — this is a
 * client-side display fold, never a new service function, per the
 * product's "one map-service facade" rule.
 */
export function buildAreaSummaries(map: ApplicationTestMap): AreaSummary[] {
  return map.areas.map((area) => ({
    ...area,
    approvedJourneyCount: area.journeys.filter((journey) => journey.status === "approved").length,
    recentFailureCount: area.journeys.filter((journey) => journey.lastRunOutcome === "failed").length,
  }));
}

const JOURNEY_MODE_LABEL: Record<ExecutionModeLabel, string> = {
  quick_test: "Quick test",
  guided_test: "Guided test",
  controlled_test: "Controlled test",
};

export function journeyModeLabel(mode: ExecutionModeLabel): string {
  return JOURNEY_MODE_LABEL[mode];
}

/**
 * A simple, honestly-documented heuristic — not a real measurement. Real
 * per-checkpoint timing does not exist anywhere in Nova today (execution
 * is one non-streaming call; see LiveExecutionScreen's own doc comment),
 * so 45s/checkpoint is a deliberately round placeholder used only to give
 * the operator a rough sense of scale before committing to a run.
 */
const ESTIMATED_SECONDS_PER_CHECKPOINT = 45;

export function estimateJourneyDurationSeconds(journey: UserJourney): number {
  return journey.checkpoints.length * ESTIMATED_SECONDS_PER_CHECKPOINT;
}

export function formatDurationLabel(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `~${minutes}m`;
}

export function resolveFirstRequiredPersonaName(
  map: ApplicationTestMap,
  journey: UserJourney,
): string | undefined {
  const firstPersonaId = journey.requiredPersonaIds[0];
  if (!firstPersonaId) {
    return undefined;
  }
  return map.personas.find((persona) => persona.id === firstPersonaId)?.name;
}

/**
 * `TestCase.recoveryBudget` is set from `allowedRecoveryActions.length > 0
 * ? 2 : 0` (see map-to-plan.ts's `checkpointsToCases`) — mirrored here only
 * as a read-only display heuristic for the pre-run summary's policy panel,
 * never re-derived as an independent policy decision.
 */
export function recoveryBudgetLabel(journey: UserJourney): string {
  return journey.allowedRecoveryActions.length > 0
    ? "Bounded recovery enabled (max 2 attempts)"
    : "Bounded recovery disabled";
}

const PRE_RUN_ACTION_LABEL: Record<ExecutionModeLabel, string> = {
  quick_test: "Run now",
  guided_test: "Review plan",
  controlled_test: "Submit for approval",
};

/** The pre-run summary screen's bottom action label — differs by journey mode, exactly per the product spec. */
export function preRunActionLabel(mode: ExecutionModeLabel): string {
  return PRE_RUN_ACTION_LABEL[mode];
}

/** Finds the area a journey belongs to — a plain data lookup, never a policy decision. */
export function findJourneyArea(map: ApplicationTestMap, journeyId: string): ApplicationArea | undefined {
  return map.areas.find((area) => area.journeys.some((journey) => journey.id === journeyId));
}

/**
 * A journey has no riskLevel field of its own — risk lives per
 * checkpoint. This mirrors the same "highest checkpoint risk wins" rule
 * `checkpointsToCases` in map-to-plan.ts already uses to set a TestCase's
 * riskLevel, so the journey-select screen's risk column always agrees
 * with what the resulting TestCase will actually carry.
 */
export function journeyRiskLevel(journey: UserJourney): "low" | "medium" | "high" {
  if (journey.checkpoints.some((checkpoint) => checkpoint.riskLevel === "high")) {
    return "high";
  }
  if (journey.checkpoints.some((checkpoint) => checkpoint.riskLevel === "medium")) {
    return "medium";
  }
  return "low";
}
