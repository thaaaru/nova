import React, { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";

import { runReport } from "../../cli/commands.js";
import type { NovaRuntime } from "../../cli/context.js";
import type { TestRunState } from "../../domain/index.js";
import { palette } from "../theme/palette.js";
import { openPathWithOsOpener } from "../services/open-path.js";

type Outcome =
  | "passed"
  | "completed_with_confirmed_defects"
  | "blocked"
  | "inconclusive"
  | "recovery_budget_exhausted"
  | "stopped_by_user";

const OUTCOME_LABEL: Record<Outcome, string> = {
  passed: "Passed",
  completed_with_confirmed_defects: "Completed with confirmed defects",
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  recovery_budget_exhausted: "Recovery budget exhausted",
  stopped_by_user: "Stopped by user",
};

const OUTCOME_COLOR: Record<Outcome, string> = {
  passed: palette.green,
  completed_with_confirmed_defects: palette.red,
  blocked: palette.red,
  inconclusive: palette.amber,
  recovery_budget_exhausted: palette.amber,
  stopped_by_user: palette.amber,
};

/**
 * Maps a run's terminal RunStatus + VerificationClassification
 * distribution to the six outcomes this screen reports. "Stopped by user"
 * is inferred from a run left in "executing" status with no terminal
 * status reached — the only way that happens in this single-operator TUI
 * is the Live Execution screen's best-effort stop control.
 */
function classifyOutcome(run: TestRunState): Outcome {
  if (run.status === "executing" || run.status === "verifying") {
    return "stopped_by_user";
  }
  if (run.status === "blocked") {
    return "blocked";
  }
  const recoveryExhausted = run.executionResults.some((execution) =>
    execution.recoveryAttempts.some((attempt) => attempt.outcome === "exhausted"),
  );
  if (recoveryExhausted) {
    return "recovery_budget_exhausted";
  }
  const classifications = run.verificationResults.map((verification) => verification.classification);
  if (classifications.length === 0) {
    return "inconclusive";
  }
  if (classifications.every((classification) => classification === "passed")) {
    return "passed";
  }
  if (classifications.some((classification) => classification === "failed")) {
    return "completed_with_confirmed_defects";
  }
  return "inconclusive";
}

type CompletionScreenProps = {
  runtime: NovaRuntime;
  run: TestRunState;
  onBeginNewRun: () => void;
  onBack: () => void;
};

export function CompletionScreen({
  runtime,
  run,
  onBeginNewRun,
  onBack,
}: CompletionScreenProps): React.ReactElement {
  const [output, setOutput] = useState<string[]>([]);
  const outcome = classifyOutcome(run);

  function openReport(): void {
    const written = runReport(runtime, { run: run.runId });
    openPathWithOsOpener(written.htmlPath);
    setOutput([`HTML report: ${written.htmlPath}`]);
  }

  function exportJunit(): void {
    const written = runReport(runtime, { run: run.runId });
    setOutput([`JUnit XML: ${written.junitPath}`]);
  }

  function openArtifacts(): void {
    const artifactsDir = `${runtime.config.artifactsDirectory}/${run.runId}`;
    openPathWithOsOpener(artifactsDir);
    setOutput([`Artifacts folder: ${artifactsDir}`]);
  }

  const items = [
    { label: "Open HTML report", value: "report" },
    { label: "Export JUnit XML", value: "junit" },
    { label: "Open artifacts folder", value: "artifacts" },
    { label: "Begin a new run from this plan", value: "new-run" },
    { label: "Return home", value: "home" },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        RUN COMPLETE
      </Text>
      <Text bold color={OUTCOME_COLOR[outcome]}>
        {OUTCOME_LABEL[outcome]}
      </Text>
      <Text color={palette.muted}>
        {run.verificationResults.filter((v) => v.classification === "passed").length} passed /{" "}
        {run.verificationResults.length} verified / {run.testPlan?.cases.length ?? 0} planned
      </Text>
      {output.map((line) => (
        <Text key={line} color={palette.cyan}>
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "report") {
              openReport();
            } else if (item.value === "junit") {
              exportJunit();
            } else if (item.value === "artifacts") {
              openArtifacts();
            } else if (item.value === "new-run") {
              onBeginNewRun();
            } else {
              onBack();
            }
          }}
        />
      </Box>
    </Box>
  );
}
