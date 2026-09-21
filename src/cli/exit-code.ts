import { CancelledInputError, NonInteractiveInputError } from "./interactive/resolve-inputs.js";
import { FixtureLockedError, JourneyScopeError } from "../services/testmap/journey-run-service.js";

/**
 * Nova's exit code taxonomy: 0 completed, 1 validation/execution failure,
 * 2 policy/approval/scope block, 130 user cancelled (SIGINT/Ctrl+C — same
 * convention a shell uses for a signal-terminated process, 128 + SIGINT's
 * signal number 2). The single top-level error handler in index.ts calls
 * this so every command reports the same code for the same failure shape,
 * instead of every catch block guessing 1.
 */
export function classifyExitCode(error: unknown): number {
  if (error instanceof CancelledInputError) {
    return 130;
  }
  if (error instanceof NonInteractiveInputError) {
    return 1;
  }
  if (error instanceof JourneyScopeError || error instanceof FixtureLockedError) {
    return 2;
  }
  return 1;
}
