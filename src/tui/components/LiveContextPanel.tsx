import React from "react";
import { Box, Text } from "ink";

import type { RunViewModel } from "../../domain/index.js";
import { palette } from "../theme/palette.js";

type LiveContextPanelProps = {
  viewModel: RunViewModel;
};

function row(label: string, value: string | undefined): React.ReactElement {
  return (
    <Text key={label}>
      <Text color={palette.muted}>{label}: </Text>
      <Text>{value ?? "—"}</Text>
    </Text>
  );
}

/** The Home screen's right pane: target, scope, test counts, policy mode, last event. */
export function LiveContextPanel({ viewModel }: LiveContextPanelProps): React.ReactElement {
  const counts = viewModel.testCounts;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={palette.border} paddingX={1} flexGrow={1}>
      <Text bold color={palette.blue}>
        LIVE CONTEXT
      </Text>
      {row("Target", viewModel.targetBaseUrl)}
      {row("Scope", viewModel.scopeSummary)}
      {row("Mode", viewModel.policyModeLabel)}
      <Text color={palette.muted}>
        Tests: <Text color={palette.green}>{counts.passed} passed</Text>,{" "}
        <Text color={palette.red}>{counts.failed} failed</Text>, {counts.flaky} flaky, {counts.blocked}{" "}
        blocked, {counts.inconclusive} inconclusive, {counts.pending} pending / {counts.planned} planned
      </Text>
      {viewModel.lastEvent
        ? row("Last event", `[${viewModel.lastEvent.stage}] ${viewModel.lastEvent.message}`)
        : row("Last event", undefined)}
      {viewModel.recovery.active ? (
        <Text color={palette.violet}>
          Recovery in progress on {viewModel.recovery.caseId ?? "case"} (attempt {viewModel.recovery.attempt}/
          {viewModel.recovery.maxAttempts})
        </Text>
      ) : null}
    </Box>
  );
}
