import { isInteractiveTTY, type PromptIO } from "./prompt-io.js";

/** The `--interactive`/`--non-interactive` flags every guided command exposes. */
export type InteractivityOptions = {
  interactive?: boolean;
  nonInteractive?: boolean;
};

export type NonInteractiveReason = "flag" | "ci" | "non-tty";

export type InteractivityDecision = {
  /** Whether the resolver is allowed to prompt at all. */
  promptingAllowed: boolean;
  /** Whether to re-prompt/review fields even when every value is already supplied and valid. */
  forceReview: boolean;
  /** Why prompting is disallowed; only meaningful when `promptingAllowed` is false. */
  reason?: NonInteractiveReason;
};

/**
 * `--non-interactive`, a CI environment, and a non-TTY stream each
 * independently force a silent, error-on-missing resolution — none of
 * them can be overridden by `--interactive`. Only once all three are
 * ruled out does `--interactive` force a full guided review even when
 * every input is already complete.
 */
export function detectInteractivity(
  options: InteractivityOptions,
  io: PromptIO = { input: process.stdin, output: process.stdout },
): InteractivityDecision {
  if (options.nonInteractive) {
    return { promptingAllowed: false, forceReview: false, reason: "flag" };
  }
  if (process.env.CI) {
    return { promptingAllowed: false, forceReview: false, reason: "ci" };
  }
  if (!isInteractiveTTY(io)) {
    return { promptingAllowed: false, forceReview: false, reason: "non-tty" };
  }
  return { promptingAllowed: true, forceReview: Boolean(options.interactive) };
}
