import React from "react";
import { Box, Text } from "ink";

import type { RecoveryAttempt, VerbosityLevel } from "../../domain/index.js";
import { palette } from "../theme/palette.js";
import { buildRecoveryCopy } from "../services/recovery-copy.js";

type RecoveryCardProps = {
  caseId: string;
  attempt: RecoveryAttempt;
  /** Standard verbosity hides internal locator-strategy/selector detail; diagnostic reveals it. */
  verbosity?: VerbosityLevel;
};

/**
 * The recovery card, rendered only from real ExecutionResult.recoveryAttempts
 * fields once the real runExecution call has resolved — never fabricated
 * from the simulated progress readout. Copy is QA language (Observed / Nova
 * proposes / Recovery: Attempt N of M), built by services/recovery-copy.ts,
 * which is also the single place internal locator/strategy detail is
 * withheld below "diagnostic" verbosity.
 */
export function RecoveryCard({
  caseId,
  attempt,
  verbosity = "standard",
}: RecoveryCardProps): React.ReactElement {
  const copy = buildRecoveryCopy(attempt, verbosity);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.violet} paddingX={1}>
      <Text bold color={palette.violet}>
        RECOVERY — {caseId}
      </Text>
      <Text bold>{copy.header}</Text>
      <Text bold color={palette.muted}>
        Observed:
      </Text>
      <Text>{copy.observed}</Text>
      <Text bold color={palette.muted}>
        Nova proposes:
      </Text>
      <Text>{copy.proposal}</Text>
      <Text bold color={palette.muted}>
        Recovery:
      </Text>
      <Text>{copy.attemptLabel}</Text>
      {copy.diagnosticDetail ? <Text color={palette.muted}>{copy.diagnosticDetail}</Text> : null}
      <Text color={attempt.outcome === "recovered" ? palette.green : palette.amber}>
        Outcome: {attempt.outcome}
      </Text>
    </Box>
  );
}
