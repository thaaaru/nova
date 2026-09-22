import React from "react";
import { Box, Text } from "ink";

import type { TimelineStageId } from "../../domain/index.js";
import { palette } from "../theme/palette.js";
import { FLOW_STAGES } from "./stage-flow.js";

type StageTrackerProps = {
  currentStage: TimelineStageId | undefined;
};

/**
 * The FLOW stage checklist: Discover, Plan, Approve, Execute, Verify,
 * Report, each with a leading glyph — done (✓, green), active (●, cyan),
 * or pending (○, muted). Static: this tracker is only ever shown on Home
 * and Map Home, which are idle screens (no live async work runs while
 * they're on screen — genuine in-flight progress has its own dedicated
 * spinner on LiveExecutionScreen/MapDiscoverScreen). An animated pulse
 * here would redraw the whole frame every tick indefinitely for a run
 * that is merely *marked* as being at that stage, not one actually
 * progressing right now — the same class of bug as the Live Execution
 * screen's paused-run redraw loop.
 */
export function StageTracker({ currentStage }: StageTrackerProps): React.ReactElement {
  const currentIndex = currentStage ? FLOW_STAGES.findIndex((stage) => stage.id === currentStage) : -1;

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        {FLOW_STAGES.map((stage, index) => {
          const isCurrent = stage.id === currentStage;
          const isPast = currentIndex !== -1 && index < currentIndex;
          const color = isCurrent ? palette.cyan : isPast ? palette.green : palette.muted;
          const glyph = isPast ? "✓" : isCurrent ? "●" : "○";
          return (
            <Text key={stage.id} color={color} bold={isCurrent}>
              {glyph} {stage.label}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
