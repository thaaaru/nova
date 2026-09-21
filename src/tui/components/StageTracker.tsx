import React from "react";
import { Box, Text } from "ink";

import type { TimelineStageId } from "../../domain/index.js";
import { palette } from "../theme/palette.js";
import { useActiveStagePulse } from "../hooks/useActiveStagePulse.js";
import { FLOW_STAGES } from "./stage-flow.js";

type StageTrackerProps = {
  currentStage: TimelineStageId | undefined;
  animationEnabled: boolean;
};

/**
 * The FLOW stage checklist: Discover, Plan, Approve, Execute, Verify,
 * Report, each with a leading glyph — done (✓, green), active (●, cyan,
 * pulsing via useActiveStagePulse when animation is enabled), or
 * pending (○, muted).
 */
export function StageTracker({ currentStage, animationEnabled }: StageTrackerProps): React.ReactElement {
  const pulse = useActiveStagePulse(currentStage, animationEnabled);
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
              {isCurrent ? pulse : ""}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
