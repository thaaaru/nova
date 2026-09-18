import React from "react";
import { Box, Text } from "ink";

import type { NextAction } from "../../domain/index.js";
import { palette } from "../theme/palette.js";

type NextActionListProps = {
  title?: string;
  actions: NextAction[];
  blockers: string[];
  selectedIndex: number;
};

/** The Home screen's left pane: "NEXT SAFE ACTION" list plus any blocked prerequisites. */
export function NextActionList({
  title = "NEXT SAFE ACTION",
  actions,
  blockers,
  selectedIndex,
}: NextActionListProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={palette.border} paddingX={1} flexGrow={1}>
      <Text bold color={palette.blue}>
        {title}
      </Text>
      {blockers.map((blocker) => (
        <Text key={blocker} color={palette.amber}>
          ! {blocker}
        </Text>
      ))}
      {actions.length === 0 && blockers.length === 0 ? (
        <Text color={palette.muted}>Nothing pending — this run is caught up.</Text>
      ) : null}
      {actions.map((action, index) => (
        <Box key={action.id} flexDirection="column" marginTop={1}>
          <Text
            color={index === selectedIndex ? palette.cyan : palette.foreground}
            bold={index === selectedIndex}
          >
            {index === selectedIndex ? "> " : "  "}
            {action.label}
          </Text>
          {action.description ? <Text color={palette.muted}>{"    " + action.description}</Text> : null}
          <Text color={palette.muted}>{"    " + action.command}</Text>
        </Box>
      ))}
    </Box>
  );
}
