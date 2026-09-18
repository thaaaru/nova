import type { RecoveryAttempt, VerbosityLevel } from "../../domain/index.js";

/**
 * Translates one real RecoveryAttempt into the QA-language phrasing the
 * product spec calls for (Observed / Nova proposes / Recovery: Attempt N
 * of M), sourced only from RecoveryAttempt's own fields — never invented.
 * At standard verbosity this also hides internal locator-strategy
 * language (`attempt.action`'s "declared selector"/"role ... loose name
 * match" wording, `attempt.checkpoint`'s raw-selector fallback from
 * `describeCheckpoint` in recovery-agent.ts) behind a generic, honest
 * description of what recovery does; the same verbosity system that
 * already tiers diagnostic-only event-feed detail (see services/
 * verbosity.ts) is reused here, surfacing the raw strategy/locator text
 * only at "diagnostic" verbosity.
 */

const LOOKS_LIKE_RAW_LOCATOR = /^[.#[]/;
const STRATEGY_LABEL_HINT = /\b(selector|role\s+"|locator|loose match|accessible label)\b/i;

function isInternalLocatorDetail(text: string): boolean {
  return LOOKS_LIKE_RAW_LOCATOR.test(text.trim()) || STRATEGY_LABEL_HINT.test(text);
}

export type RecoveryCopy = {
  header: string;
  observed: string;
  proposal: string;
  attemptLabel: string;
  /** Only set at "diagnostic" verbosity — the raw strategy label and locator hint. */
  diagnosticDetail?: string;
};

const GENERIC_PROPOSAL =
  "Nova proposes rediscovering the approved control using an alternate accessibility signal and " +
  "resuming from the last completed checkpoint.";

export function buildRecoveryCopy(attempt: RecoveryAttempt, verbosity: VerbosityLevel): RecoveryCopy {
  const showDiagnostic = verbosity === "diagnostic";
  const header =
    !showDiagnostic && isInternalLocatorDetail(attempt.checkpoint)
      ? "Checkpoint action could not be completed."
      : `${attempt.checkpoint} could not be completed.`;
  const proposal =
    showDiagnostic || !isInternalLocatorDetail(attempt.action) ? attempt.action : GENERIC_PROPOSAL;

  return {
    header,
    observed: attempt.failureSummary,
    proposal,
    attemptLabel: `Attempt ${attempt.attempt} of ${attempt.maxAttempts}`,
    diagnosticDetail: showDiagnostic
      ? `Strategy: ${attempt.action}  ·  Checkpoint locator: ${attempt.checkpoint}`
      : undefined,
  };
}
