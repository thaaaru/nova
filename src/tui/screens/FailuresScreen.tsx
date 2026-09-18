import React from "react";
import { Box, Text, useInput } from "ink";

import type { NovaRuntime } from "../../cli/context.js";
import type { TestRunState } from "../../domain/index.js";
import { palette } from "../theme/palette.js";

type FailuresScreenProps = {
  runtime: NovaRuntime;
  onBack: () => void;
};

function hadRecoveryOrFailure(run: TestRunState): boolean {
  const hadRecovery = run.executionResults.some((execution) => execution.recoveryAttempts.length > 0);
  const hadFailedVerification = run.verificationResults.some(
    (verification) => verification.classification === "failed",
  );
  return hadRecovery || hadFailedVerification;
}

/**
 * "Review failures and recoveries" — no dedicated failures data path
 * exists elsewhere in the TUI yet (CompletionScreen shows one run's own
 * outcome, not a cross-run listing), so this pulls directly from
 * `runtime.repository.list()` — the same durable run store every other
 * screen already reads — and filters to runs carrying a real recovery
 * attempt or a confirmed-failed verification, never a new service.
 */
export function FailuresScreen({ runtime, onBack }: FailuresScreenProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  const runs = runtime.repository.list().filter(hadRecoveryOrFailure);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        REVIEW FAILURES AND RECOVERIES
      </Text>
      {runs.length === 0 ? (
        <Text color={palette.muted}>No run has recorded a failure or recovery attempt yet.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {runs.map((run) => {
            const recoveryCount = run.executionResults.reduce(
              (total, execution) => total + execution.recoveryAttempts.length,
              0,
            );
            const failedCount = run.verificationResults.filter(
              (verification) => verification.classification === "failed",
            ).length;
            return (
              <Text key={run.runId}>
                {run.runId.slice(0, 8)} — {run.status} — {failedCount} confirmed defect(s), {recoveryCount}{" "}
                recovery attempt(s)
              </Text>
            );
          })}
        </Box>
      )}
      <Text color={palette.muted}>[Esc] Back</Text>
    </Box>
  );
}
