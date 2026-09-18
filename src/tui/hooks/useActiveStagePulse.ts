import { useEffect, useState } from "react";

const FRAME_INTERVAL_MS = 400;
const DOT_FRAMES = [".", "..", "..."];

/**
 * Nova's one sanctioned animation: a shifting three-dot indicator for
 * whichever FLOW stage is currently active. When `enabled` is false this
 * hook does not merely hide the dots — it never starts the interval, so a
 * disabled TUI performs zero extra re-renders for this effect.
 */
export function useActiveStagePulse(activeStageId: string | undefined, enabled: boolean): string {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!enabled || activeStageId === undefined) {
      return;
    }
    const interval = setInterval(() => {
      setFrame((previous) => (previous + 1) % DOT_FRAMES.length);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, activeStageId]);

  if (!enabled || activeStageId === undefined) {
    return "";
  }
  return DOT_FRAMES[frame] ?? "";
}
