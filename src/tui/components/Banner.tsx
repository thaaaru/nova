import React from "react";
import { Box, Text } from "ink";

import { palette } from "../theme/palette.js";

const WORDMARK = [
  " _   _   ___   __     __    _",
  "| \\ | | / _ \\  \\ \\   / /   / \\",
  "|  \\| || | | |  \\ \\ / /   / _ \\",
  "| |\\  || |_| |   \\ V /   / ___ \\",
  "|_| \\_| \\___/     \\_/   /_/   \\_\\",
];

const NARROW_COLUMNS_THRESHOLD = 50;

export type BannerProps = {
  columns: number;
};

/**
 * One-time startup banner. Purely presentational — no workflow/business
 * logic lives here. Callers decide *whether* to render it (TTY/CI/JSON
 * gating, `--no-banner`) and render it exactly once per session.
 */
export function Banner({ columns }: BannerProps): React.ReactElement {
  if (columns < NARROW_COLUMNS_THRESHOLD) {
    return (
      <Box>
        <Text color={palette.cyan}>NOVA</Text>
        <Text color={palette.muted}>
          {" "}
          | Discover {">"} Approve {">"} Execute
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {WORDMARK.map((line, index) => (
        <Text key={index} color={palette.cyan}>
          {line}
        </Text>
      ))}
      <Text color={palette.muted}>
        Discover {">"} Approve {">"} Execute
      </Text>
    </Box>
  );
}

/**
 * Decides whether the startup banner should render: only for a genuine
 * new interactive TTY session, never for CI/non-TTY/JSON/piped output,
 * and never when the operator passed --no-banner.
 */
export function shouldShowBanner(options: {
  isTTY: boolean;
  noBanner?: boolean;
  json?: boolean;
  ci?: boolean;
}): boolean {
  if (options.noBanner) return false;
  if (options.json) return false;
  if (options.ci) return false;
  if (!options.isTTY) return false;
  return true;
}
