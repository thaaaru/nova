import React from "react";
import { Box, Text } from "ink";

import type { RunEvent, RunEventLevel } from "../../domain/index.js";
import { palette } from "../theme/palette.js";

const LEVEL_COLOR: Record<RunEventLevel, string> = {
  info: palette.cyan,
  warning: palette.amber,
  error: palette.red,
  recovery: palette.violet,
  approval: palette.amber,
};

type EventFeedProps = {
  events: RunEvent[];
  maxRows?: number;
};

/** A recent-event feed, already pre-filtered to the active verbosity level by the caller. */
export function EventFeed({ events, maxRows = 8 }: EventFeedProps): React.ReactElement {
  const visible = events.slice(-maxRows);
  return (
    <Box flexDirection="column">
      {visible.length === 0 ? <Text color={palette.muted}>No events yet.</Text> : null}
      {visible.map((event) => (
        <Text key={event.id} color={LEVEL_COLOR[event.level]}>
          [{event.stage}] {event.message}
        </Text>
      ))}
    </Box>
  );
}
