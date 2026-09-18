import React from "react";
import { Box, Text } from "ink";

import { palette } from "../theme/palette.js";

type KeyHintBarProps = {
  hints: Array<{ key: string; label: string }>;
};

/** The bottom key-hint bar, e.g. "[Enter] Select  [up/down] Navigate  [V] Verbosity  [:] Command  [Q] Quit". */
export function KeyHintBar({ hints }: KeyHintBarProps): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor={palette.border} paddingX={1}>
      <Text>
        {hints.map((hint, index) => (
          <Text key={hint.key}>
            <Text color={palette.cyan}>[{hint.key}]</Text> <Text color={palette.muted}>{hint.label}</Text>
            {index < hints.length - 1 ? "   " : ""}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
