import React from "react";
import { Box, Text } from "ink";

import type { RecoveryAttempt } from "../../domain/index.js";
import { palette } from "../theme/palette.js";

type RecoveryCardProps = {
  caseId: string;
  attempt: RecoveryAttempt;
};

/**
 * The "RECOVERY IN PROGRESS" card, rendered only from real
 * ExecutionResult.recoveryAttempts fields once the real runExecution call
 * has resolved — never fabricated from the simulated progress readout.
 */
export function RecoveryCard({ caseId, attempt }: RecoveryCardProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.violet} paddingX={1}>
      <Text bold color={palette.violet}>
        RECOVERY IN PROGRESS — {caseId}
      </Text>
      <Text>
        <Text color={palette.muted}>Failure: </Text>
        {attempt.failureSummary}
      </Text>
      <Text>
        <Text color={palette.muted}>Evidence: </Text>
        {attempt.evidenceSummary}
      </Text>
      <Text>
        <Text color={palette.muted}>Action: </Text>
        {attempt.action}
      </Text>
      <Text>
        <Text color={palette.muted}>Attempt: </Text>
        {attempt.attempt} of {attempt.maxAttempts}
      </Text>
      <Text>
        <Text color={palette.muted}>Checkpoint: </Text>
        {attempt.checkpoint}
      </Text>
      <Text color={attempt.outcome === "recovered" ? palette.green : palette.amber}>
        Outcome: {attempt.outcome}
      </Text>
    </Box>
  );
}
