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
 * The FLOW stage tracker: Discover -> Plan -> Approve -> Execute -> Verify
 * -> Report, with a marker under whichever stage is active. The active
 * stage's dots pulse via useActiveStagePulse when animation is enabled.
 */
export function StageTracker({ currentStage, animationEnabled }: StageTrackerProps): React.ReactElement {
  const pulse = useActiveStagePulse(currentStage, animationEnabled);

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        {FLOW_STAGES.map((stage, index) => {
          const isCurrent = stage.id === currentStage;
          const isPast =
            currentStage !== undefined && index < FLOW_STAGES.findIndex((s) => s.id === currentStage);
          const color = isCurrent ? palette.cyan : isPast ? palette.green : palette.muted;
          return (
            <Text key={stage.id} color={color} bold={isCurrent}>
              {stage.label}
              {isCurrent ? pulse : ""}
              {index < FLOW_STAGES.length - 1 ? "  ->" : ""}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
