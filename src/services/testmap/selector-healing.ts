import type { ApplicationTestMap, RecoveryAttempt, UserJourney } from "../../domain/index.js";

/**
 * Persistent, self-learning selector healing: when a journey run's
 * runtime recovery (attemptStepRecovery) finds a concrete alternate
 * selector that uniquely resolves a checkpoint's step, this module
 * writes that selector back onto the ApplicationTestMap itself — so the
 * *next* run of the same journey finds the element on the first try
 * instead of needing runtime recovery again. Purely deterministic: it
 * only ever applies a selector the recovery agent already proved
 * resolves to exactly one element on a real page; it never guesses,
 * never touches an "exhausted"/"blocked_by_policy" attempt, and never
 * changes what a checkpoint asserts or does.
 */

export type HealCandidate = {
  journeyId: string;
  checkpointId: string;
  stepIndexInCheckpoint: number;
  healedSelector: string;
};

/**
 * `checkpointsToCases` (map-to-plan.ts) flattens every checkpoint's steps
 * into one TestCase step list, so a RecoveryAttempt's `stepIndex` is an
 * index into that flattened list, not into any one checkpoint's own
 * steps. This walks the journey's checkpoints in the same order to
 * translate a flattened index back to which checkpoint — and which step
 * within it — actually produced that attempt.
 */
export function locateCheckpointStep(
  journey: UserJourney,
  flatStepIndex: number,
): { checkpointId: string; stepIndexInCheckpoint: number } | undefined {
  let cursor = 0;
  for (const checkpoint of journey.checkpoints) {
    if (flatStepIndex < cursor + checkpoint.steps.length) {
      return { checkpointId: checkpoint.id, stepIndexInCheckpoint: flatStepIndex - cursor };
    }
    cursor += checkpoint.steps.length;
  }
  return undefined;
}

/**
 * Derives the set of checkpoint-step selector updates a completed run
 * earned — one candidate per `recovered` attempt that also carries a
 * concrete `healedSelector`. Attempts that were never recovered never
 * produce a candidate: this function only ever proposes selectors the
 * recovery agent already verified resolve uniquely.
 */
export function deriveHealCandidates(
  journey: UserJourney,
  recoveryAttempts: readonly RecoveryAttempt[],
): HealCandidate[] {
  const candidates: HealCandidate[] = [];
  for (const attempt of recoveryAttempts) {
    if (attempt.outcome !== "recovered" || !attempt.healedSelector) {
      continue;
    }
    const located = locateCheckpointStep(journey, attempt.stepIndex);
    if (!located) {
      continue;
    }
    candidates.push({
      journeyId: journey.id,
      checkpointId: located.checkpointId,
      stepIndexInCheckpoint: located.stepIndexInCheckpoint,
      healedSelector: attempt.healedSelector,
    });
  }
  return candidates;
}

/**
 * Pure, immutable: returns a new ApplicationTestMap with the given
 * checkpoint steps' `selector` field replaced by whatever the recovery
 * agent proved resolves uniquely. Never mutates the input map; a
 * candidate naming a journey/checkpoint/step that no longer exists on
 * the map (e.g. curated away since the run started) is silently
 * dropped rather than raising — the map, not a stale run, is the source
 * of truth for what checkpoints currently exist.
 */
export function applySelectorHeals(
  map: ApplicationTestMap,
  candidates: readonly HealCandidate[],
): ApplicationTestMap {
  if (candidates.length === 0) {
    return map;
  }

  const byJourneyAndCheckpoint = new Map<string, Map<number, string>>();
  for (const candidate of candidates) {
    const key = `${candidate.journeyId}::${candidate.checkpointId}`;
    const byStep = byJourneyAndCheckpoint.get(key) ?? new Map<number, string>();
    byStep.set(candidate.stepIndexInCheckpoint, candidate.healedSelector);
    byJourneyAndCheckpoint.set(key, byStep);
  }

  let changed = false;
  const areas = map.areas.map((area) => ({
    ...area,
    journeys: area.journeys.map((journey) => ({
      ...journey,
      checkpoints: journey.checkpoints.map((checkpoint) => {
        const byStep = byJourneyAndCheckpoint.get(`${journey.id}::${checkpoint.id}`);
        if (!byStep) {
          return checkpoint;
        }
        return {
          ...checkpoint,
          steps: checkpoint.steps.map((step, index) => {
            const healedSelector = byStep.get(index);
            if (!healedSelector || healedSelector === step.selector) {
              return step;
            }
            changed = true;
            return { ...step, selector: healedSelector };
          }),
        };
      }),
    })),
  }));

  if (!changed) {
    return map;
  }

  return { ...map, areas, updatedAt: new Date().toISOString() };
}
