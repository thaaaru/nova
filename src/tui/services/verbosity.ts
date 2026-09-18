import type { RunEvent, VerbosityLevel } from "../../domain/index.js";

/**
 * Verbosity is a total order (executive < standard < diagnostic); an event
 * is shown at a given viewing level iff its own `minVerbosity` rank is at
 * or below that level's rank. This is the one place that ordering is
 * defined so the Home/Live-Execution event feeds and view-model's
 * `lastEvent` selection can never disagree about what "diagnostic-only"
 * means.
 */
const VERBOSITY_RANK: Record<VerbosityLevel, number> = { executive: 0, standard: 1, diagnostic: 2 };

export function isVisibleAtVerbosity(event: RunEvent, level: VerbosityLevel): boolean {
  return VERBOSITY_RANK[event.minVerbosity] <= VERBOSITY_RANK[level];
}

export function filterEventsByVerbosity(events: RunEvent[], level: VerbosityLevel): RunEvent[] {
  return events.filter((event) => isVisibleAtVerbosity(event, level));
}
