import { useRef } from "react";
import { useInput, type Key } from "ink";

/**
 * `useInput`, but deaf for a moment after mount.
 *
 * Raw-mode stdin delivers whatever was already buffered when a screen
 * attaches: a leftover Return from the shell command that launched Nova,
 * the Enter that dismissed the previous screen, or a terminal's
 * shell-integration escape sequences. On an ordinary screen that is a
 * cosmetic annoyance; on a decision gate it is not — a stray Return must
 * never be able to confirm an application identification or start a test
 * run on the operator's behalf.
 *
 * Same guard the startup banner uses (see components/Banner.tsx and its
 * call site in app.tsx), extracted so every gate shares one definition.
 */
const DEFAULT_GUARD_MS = 250;

export function useSettledInput(
  handler: (input: string, key: Key) => void,
  options: { isActive?: boolean; guardMs?: number } = {},
): void {
  const mountedAtRef = useRef(Date.now());
  useInput(
    (input, key) => {
      if (Date.now() - mountedAtRef.current < (options.guardMs ?? DEFAULT_GUARD_MS)) {
        return;
      }
      handler(input, key);
    },
    { isActive: options.isActive },
  );
}
