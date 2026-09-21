import { useEffect, useState } from "react";

const FRAME_INTERVAL_MS = 80;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Braille spinner glyph for whatever is actively in progress — the same
 * cadence/frame set terminal prompts (e.g. omp) use for an in-flight
 * command. Gated by `active`/`enabled` the same way useActiveStagePulse is:
 * when either is false the interval never starts, so a stopped run or a
 * disabled-animation TUI performs zero extra re-renders for this effect.
 */
export function useSpinnerFrame(active: boolean, enabled: boolean): string {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active || !enabled) {
      return;
    }
    const interval = setInterval(() => {
      setFrame((previous) => (previous + 1) % SPINNER_FRAMES.length);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active, enabled]);

  if (!active) {
    return "";
  }
  if (!enabled) {
    return "•";
  }
  return SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0];
}
