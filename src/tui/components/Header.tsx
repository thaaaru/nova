import React from "react";
import { Box, Text } from "ink";

import type { RunViewModel } from "../../domain/index.js";
import { palette } from "../theme/palette.js";

type HeaderProps = {
  viewModel: RunViewModel;
};

/** Boxed header: project/run/mode, ASCII-art-free by design. */
export function Header({ viewModel }: HeaderProps): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor={palette.border} paddingX={1} justifyContent="space-between">
      <Text bold color={palette.cyan}>
        NOVA{viewModel.projectId ? ` — ${viewModel.projectId}` : ""}
      </Text>
      <Text color={palette.muted}>
        {viewModel.runId ? `run ${viewModel.runId.slice(0, 8)}` : "no run"}
        {viewModel.environment ? `  ·  ${viewModel.environment}` : ""}
        {viewModel.status ? `  ·  ${viewModel.status}` : ""}
      </Text>
    </Box>
  );
}
