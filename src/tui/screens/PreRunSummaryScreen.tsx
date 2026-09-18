import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import type { NovaRuntime } from "../../cli/context.js";
import type { ApplicationTestMap, TestRunState, UserJourney, VerbosityLevel } from "../../domain/index.js";
import { runJourney, type RunJourneyOptions } from "../../services/testmap/map-service.js";
import type { PreparedJourneyRun } from "../../services/testmap/journey-run-service.js";
import { palette } from "../theme/palette.js";
import { RecoveryCard } from "../components/RecoveryCard.js";
import { preRunActionLabel, recoveryBudgetLabel } from "../services/testmap-view-model.js";
import type { SelectedTestContext } from "./TestContextScreen.js";

/** Presentational pacing labels shown while the one real `runJourney` await is in flight — same honestly-documented precedent as DiscoveryScreen. */
const WORKING_LABELS = ["Validating approved scope", "Acquiring fixture locks", "Preparing test plan"];
const LABEL_INTERVAL_MS = 500;

type Phase = "summary" | "working" | "staged" | "submitted" | "error";

type PreRunSummaryScreenProps = {
  runtime: NovaRuntime;
  map: ApplicationTestMap;
  journey: UserJourney;
  context: SelectedTestContext;
  verbosity: VerbosityLevel;
  /**
   * quick_test only: the journey has already fully executed by the time
   * `runJourney` resolves (see journey-run-service.ts's startJourneyRun,
   * which awaits confirmJourneyRun itself for quick_test before
   * returning) — this hands the finished run straight to the caller to
   * route to the report/completion screen.
   */
  onQuickRunComplete: (finalRun: TestRunState) => void;
  /**
   * guided_test only: the run is staged (awaiting_approval) but not yet
   * executed. The caller drives the actual approve+execute call by
   * reusing LiveExecutionScreen with its `executor` prop bound to
   * `mapService.confirmRun` — this screen never calls confirmRun itself.
   */
  onReadyToConfirm: (runId: string) => void;
  onBack: () => void;
};

/**
 * Step 4 of "Test an application area" (also reused by "Describe a test"
 * and "Run recommended regression tests" once they resolve to a specific
 * journey). Calls `mapService.runJourney` only — never reimplements
 * scope validation, fixture locking, or plan generation. The bottom
 * action and what happens next differ exactly by journey.mode:
 * quick_test executes immediately, guided_test stages then hands off to
 * an explicit confirm step, controlled_test stages and directs the
 * operator to a separate CLI approval — it is never auto-confirmed here.
 */
export function PreRunSummaryScreen({
  runtime,
  map,
  journey,
  context,
  verbosity,
  onQuickRunComplete,
  onReadyToConfirm,
  onBack,
}: PreRunSummaryScreenProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("summary");
  const [labelIndex, setLabelIndex] = useState(0);
  const [preparedRun, setPreparedRun] = useState<PreparedJourneyRun | undefined>(undefined);
  const [finalRun, setFinalRun] = useState<TestRunState | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    [],
  );

  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (phase === "summary" && key.return) {
      void start();
    }
    if (phase === "staged" && journey.mode === "guided_test" && key.return && preparedRun) {
      onReadyToConfirm(preparedRun.runId);
    }
    if (phase === "staged" && journey.mode === "quick_test" && key.return && finalRun) {
      onQuickRunComplete(finalRun);
    }
    if ((phase === "submitted" || phase === "error") && (key.return || input === " ")) {
      onBack();
    }
  });

  async function start(): Promise<void> {
    setPhase("working");
    setLabelIndex(0);
    const labelTimer = setInterval(() => {
      setLabelIndex((previous) => Math.min(previous + 1, WORKING_LABELS.length - 1));
    }, LABEL_INTERVAL_MS);

    const options: RunJourneyOptions = {
      mapId: map.id,
      journeyId: journey.id,
      environment: context.environment,
      personaId: context.personaId,
      fixtureIds: context.fixtureIds,
    };

    try {
      const result = await runJourney(runtime, options);
      clearInterval(labelTimer);
      if (cancelledRef.current) {
        return;
      }
      setPreparedRun(result);

      if (journey.mode === "controlled_test") {
        setPhase("submitted");
        return;
      }
      if (journey.mode === "guided_test") {
        setPhase("staged");
        return;
      }
      // quick_test: already fully executed inside runJourney.
      const executed = runtime.repository.get(result.runId);
      if (executed) {
        setFinalRun(executed);
      }
      setPhase("staged");
    } catch (error) {
      clearInterval(labelTimer);
      if (!cancelledRef.current) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setPhase("error");
      }
    }
  }

  const recoveryAttempts = (finalRun?.executionResults ?? []).flatMap((execution) =>
    execution.recoveryAttempts.map((attempt) => ({ caseId: execution.caseId, attempt })),
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        PRE-RUN SUMMARY — {journey.name}
      </Text>
      <Text bold color={palette.muted}>
        Goal:
      </Text>
      <Text>{journey.description}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={palette.muted}>
          Checkpoints:
        </Text>
        {journey.checkpoints.map((checkpoint, index) => (
          <Text key={checkpoint.id}>
            {index + 1}. {checkpoint.name}
          </Text>
        ))}
      </Box>
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="single"
        borderColor={palette.border}
        paddingX={1}
      >
        <Text bold color={palette.blue}>
          POLICY
        </Text>
        <Text>
          <Text color={palette.muted}>Execution mode: </Text>
          {map.approvedScope.executionMode}
        </Text>
        <Text>
          <Text color={palette.muted}>Approved target scope: </Text>
          {map.approvedScope.allowedDomains.join(", ")}
        </Text>
        <Text>
          <Text color={palette.muted}>Recovery budget: </Text>
          {recoveryBudgetLabel(journey)}
        </Text>
      </Box>

      {phase === "working" ? <Text color={palette.cyan}>{WORKING_LABELS[labelIndex]}…</Text> : null}

      {phase === "staged" && journey.mode === "guided_test" && preparedRun ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor={palette.cyan}
          paddingX={1}
        >
          <Text bold color={palette.cyan}>
            REVIEWED PLAN
          </Text>
          {preparedRun.cases.map((testCase) => (
            <Text key={testCase.id}>
              {testCase.title} — {testCase.riskLevel} risk — {testCase.executionMode}
            </Text>
          ))}
          <Text color={palette.muted}>[Enter] Run [Esc] Back</Text>
        </Box>
      ) : null}

      {phase === "staged" && journey.mode === "quick_test" ? (
        <Box flexDirection="column" marginTop={1}>
          {recoveryAttempts.map(({ caseId, attempt }, index) => (
            <RecoveryCard
              key={`${caseId}-${index}`}
              caseId={caseId}
              attempt={attempt}
              verbosity={verbosity}
            />
          ))}
          <Text bold color={finalRun?.status === "completed" ? palette.green : palette.amber}>
            Result: {finalRun?.status ?? "unknown"}
          </Text>
          <Text color={palette.muted}>[Enter] Continue</Text>
        </Box>
      ) : null}

      {phase === "submitted" && journey.mode === "controlled_test" ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor={palette.amber}
          paddingX={1}
        >
          <Text bold color={palette.amber}>
            SUBMITTED FOR APPROVAL
          </Text>
          <Text>
            Run {preparedRun?.runId} is staged and awaiting a separate approval decision — controlled_test
            journeys are never auto-confirmed from the TUI.
          </Text>
          <Text color={palette.muted}>
            Next step: a QA lead approves it with `nova approve --plan {preparedRun?.runId}` (or `nova journey
            confirm --run {preparedRun?.runId}`).
          </Text>
          <Text color={palette.muted}>[Enter] Back to menu</Text>
        </Box>
      ) : null}

      {phase === "error" ? <Text color={palette.red}>Failed: {errorMessage}</Text> : null}

      {phase === "summary" ? (
        <Text color={palette.cyan}>[Enter] {preRunActionLabel(journey.mode)} [Esc] Back</Text>
      ) : null}
    </Box>
  );
}
