import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import { runExecution, type ExecutionResultSummary } from "../../cli/commands.js";
import type { NovaRuntime } from "../../cli/context.js";
import type { RunEvent, TestRunState, VerbosityLevel } from "../../domain/index.js";
import { palette } from "../theme/palette.js";
import { EventFeed } from "../components/EventFeed.js";
import { RecoveryCard } from "../components/RecoveryCard.js";
import { makeEvent } from "../services/make-event.js";
import { filterEventsByVerbosity } from "../services/verbosity.js";
import { useSpinnerFrame } from "../hooks/useSpinnerFrame.js";

type SimulatedStatus = "pending" | "running" | "passed" | "failed";

const SIMULATION_TICK_MS = 900;

/** `Nh NNm NNs`, omitting the hour component when it is zero. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s` : `${minutes}m ${pad(seconds)}s`;
}

const RECOVERY_DECISION_OPTIONS = ["Continue automatically", "Stop run"] as const;

type LiveExecutionScreenProps = {
  runtime: NovaRuntime;
  run: TestRunState;
  verbosity: VerbosityLevel;
  animationEnabled: boolean;
  paused: boolean;
  onTogglePause: () => void;
  onComplete: (finalRun: TestRunState) => void;
  onStop: () => void;
  onCycleVerbosity: () => void;
  onOpenCommandMode: () => void;
  /** False while the `:`-mode command bar owns keyboard input, so keystrokes are never handled twice. */
  inputActive?: boolean;
  /**
   * Overrides the default `runExecution(runtime, { plan: run.runId })`
   * call this screen awaits — e.g. the Application Test Map journey flow
   * passes `() => mapService.confirmRun(runtime, run.runId, reviewer)` so
   * a guided_test journey's real approve+execute call drives the exact
   * same live-progress/recovery-card UI as the plain CLI plan-review
   * path, instead of a second, duplicate execution call.
   */
  executor?: () => Promise<ExecutionResultSummary>;
};

/**
 * Nova's `runExecution` (src/cli/commands.ts) runs an entire approved
 * TestPlan to completion inside one awaited call — there is no
 * per-checkpoint streaming API today. This screen simulates a believable
 * in-order progress readout across the plan's cases while that one real
 * call is in flight, then reconciles every case against the real
 * ExecutionResultSummary/VerificationResult the instant it resolves,
 * correcting any case whose simulated status guessed wrong. Recovery
 * cards render only from real `recoveryAttempts` on the resolved
 * ExecutionResult, never from the simulation.
 *
 * "Pause" and "stop" are scoped honestly to what this API allows: pause
 * only freezes the simulated readout (the real browser automation, once
 * started, cannot be paused mid-flight without a commands.ts change);
 * stop returns to Home without auto-opening verify/report, but cannot
 * abort the in-flight Playwright run itself.
 */
export function LiveExecutionScreen({
  runtime,
  run,
  verbosity,
  animationEnabled,
  paused,
  onTogglePause,
  onComplete,
  onStop,
  onCycleVerbosity,
  onOpenCommandMode,
  inputActive = true,
  executor,
}: LiveExecutionScreenProps): React.ReactElement {
  const plan = run.testPlan;
  const cases = plan?.cases ?? [];

  const [statuses, setStatuses] = useState<SimulatedStatus[]>(() => cases.map(() => "pending"));
  const [runningIndex, setRunningIndex] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [finalRun, setFinalRun] = useState<TestRunState | undefined>(undefined);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [showEvidence, setShowEvidence] = useState(false);
  const [showRecoveryGateDialog, setShowRecoveryGateDialog] = useState(false);
  const [recoveryDialogIndex, setRecoveryDialogIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const startedAtRef = useRef(Date.now());
  const stoppedRef = useRef(false);
  const pausedRef = useRef(false);

  pausedRef.current = paused;

  const isInProgress = !stopped && !finalRun && !errorMessage;
  const spinnerFrame = useSpinnerFrame(isInProgress && !paused, animationEnabled);

  function handleStop(): void {
    stoppedRef.current = true;
    setStopped(true);
    onStop();
  }

  useInput(
    (input, key) => {
      if (showRecoveryGateDialog) {
        if (key.escape) {
          setShowRecoveryGateDialog(false);
          return;
        }
        if (key.upArrow) {
          setRecoveryDialogIndex((index) => Math.max(0, index - 1));
        }
        if (key.downArrow) {
          setRecoveryDialogIndex((index) => Math.min(RECOVERY_DECISION_OPTIONS.length - 1, index + 1));
        }
        if (key.return) {
          if (recoveryDialogIndex === 0) {
            setShowRecoveryGateDialog(false);
          } else {
            handleStop();
          }
          return;
        }
        const digit = Number(input);
        if (digit === 1) {
          setShowRecoveryGateDialog(false);
          return;
        }
        if (digit === 2) {
          handleStop();
          return;
        }
        return;
      }
      if (input === "p") {
        onTogglePause();
      }
      if (input === "s" || key.escape) {
        handleStop();
      }
      if (input === "e") {
        setShowEvidence((value) => !value);
      }
      if (input === "a") {
        setRecoveryDialogIndex(0);
        setShowRecoveryGateDialog(true);
      }
      if (input === "v" || input === "V") {
        onCycleVerbosity();
      }
      if (input === ":") {
        onOpenCommandMode();
      }
    },
    { isActive: inputActive },
  );

  useEffect(() => {
    if (!plan) {
      return;
    }
    setEvents((previous) => [
      ...previous,
      makeEvent(
        "execute",
        "info",
        "standard",
        `Starting execution of plan ${plan.id} (${cases.length} case(s))`,
      ),
    ]);

    const tickTimer = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
      if (pausedRef.current || stoppedRef.current) {
        return;
      }
      setRunningIndex((previous) => {
        const next = Math.min(previous + 1, cases.length - 1);
        setStatuses((current) =>
          current
            .map((status, index) => (index === previous ? "passed" : status))
            .map((status, index) => (index === next && next !== previous ? "running" : status)),
        );
        return next;
      });
    }, SIMULATION_TICK_MS);

    async function run_(): Promise<void> {
      try {
        const summary = await (executor ? executor() : runExecution(runtime, { plan: run.runId }));
        clearInterval(tickTimer);
        if (stoppedRef.current) {
          return;
        }
        const updated = runtime.repository.get(run.runId);
        if (updated) {
          reconcileStatuses(updated);
          setFinalRun(updated);
          setEvents((previous) => [
            ...previous,
            makeEvent("execute", "info", "standard", `Execution finished: ${summary.status}`),
          ]);
          onComplete(updated);
        }
      } catch (error) {
        clearInterval(tickTimer);
        if (!stoppedRef.current) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }
    }

    function reconcileStatuses(updated: TestRunState): void {
      const byCaseId = new Map(
        updated.verificationResults.map((verification) => [verification.caseId, verification]),
      );
      setStatuses(
        cases.map((testCase) => {
          const verification = byCaseId.get(testCase.id);
          if (!verification) {
            return "pending";
          }
          return verification.classification === "passed" ? "passed" : "failed";
        }),
      );
    }

    void run_();
    return () => {
      clearInterval(tickTimer);
    };
  }, []);

  if (!plan) {
    return (
      <Box borderStyle="round" borderColor={palette.amber} paddingX={1}>
        <Text color={palette.amber}>No test plan to execute.</Text>
      </Box>
    );
  }

  const counts = statuses.reduce(
    (acc, status) => {
      acc[status] += 1;
      return acc;
    },
    { pending: 0, running: 0, passed: 0, failed: 0 } as Record<SimulatedStatus, number>,
  );

  const activeRecovery = finalRun?.executionResults
    .flatMap((execution) => execution.recoveryAttempts.map((attempt) => ({ execution, attempt })))
    .at(0);
  const recoveryCount = (finalRun?.executionResults ?? []).reduce(
    (total, execution) => total + execution.recoveryAttempts.length,
    0,
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        {isInProgress && !paused && animationEnabled ? `${spinnerFrame} ` : ""}
        LIVE EXECUTION — {plan.id}
      </Text>
      <Text color={palette.muted}>
        Checkpoint {Math.min(runningIndex + 1, cases.length)} of {cases.length} · Elapsed:{" "}
        {formatElapsed(elapsedMs)} · Recovery: {recoveryCount}
      </Text>
      <Text>
        <Text color={palette.green}>{counts.passed} passed</Text>,{" "}
        <Text color={palette.red}>{counts.failed} failed</Text>, {counts.pending} pending
      </Text>
      {stopped ? (
        <Text color={palette.amber}>Stopped by user — will not auto-open verify/report.</Text>
      ) : null}
      {errorMessage ? <Text color={palette.red}>Execution error: {errorMessage}</Text> : null}
      <Box flexDirection="column" marginY={1}>
        {cases.map((testCase, index) => (
          <Text
            key={testCase.id}
            color={
              statuses[index] === "passed"
                ? palette.green
                : statuses[index] === "failed"
                  ? palette.red
                  : statuses[index] === "running"
                    ? palette.cyan
                    : palette.muted
            }
          >
            {statuses[index] === "running" && spinnerFrame ? `${spinnerFrame} ` : ""}[{statuses[index]}]{" "}
            {testCase.title}
          </Text>
        ))}
      </Box>
      {activeRecovery ? (
        <RecoveryCard
          caseId={activeRecovery.execution.caseId}
          attempt={activeRecovery.attempt}
          verbosity={verbosity}
        />
      ) : null}
      {showEvidence ? (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={palette.violet}
          paddingX={1}
          marginTop={1}
        >
          <Text bold color={palette.violet}>
            EVIDENCE
          </Text>
          {(finalRun?.executionResults ?? []).flatMap((execution) => execution.screenshots).length === 0 ? (
            <Text color={palette.muted}>No evidence captured yet.</Text>
          ) : (
            (finalRun?.executionResults ?? []).map((execution) => (
              <Box key={execution.caseId} flexDirection="column">
                <Text>{execution.caseId}</Text>
                {execution.screenshots.map((path) => (
                  <Text key={path} color={palette.muted}>
                    {"  screenshot: "}
                    {path}
                  </Text>
                ))}
                {execution.tracePath ? (
                  <Text color={palette.muted}> trace: {execution.tracePath}</Text>
                ) : null}
              </Box>
            ))
          )}
        </Box>
      ) : null}
      {showRecoveryGateDialog ? (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={palette.amber}
          paddingX={1}
          marginTop={1}
        >
          <Text bold color={palette.amber}>
            Recovery is bounded and policy-safe — only retries alternate locators for the same declared
            element, capped by the case's recovery budget. It never touches scope, secrets, or approval.
          </Text>
          {RECOVERY_DECISION_OPTIONS.map((option, index) => (
            <Text
              key={option}
              color={index === recoveryDialogIndex ? palette.cyan : palette.foreground}
              bold={index === recoveryDialogIndex}
            >
              {index === recoveryDialogIndex ? "> " : "  "}
              {index + 1}. {option}
            </Text>
          ))}
          <Text color={palette.muted}>[Enter] Select [Esc] Dismiss</Text>
        </Box>
      ) : null}
      <EventFeed events={filterEventsByVerbosity(events, verbosity)} />
      <Text color={palette.muted}>
        [P] {paused ? "Resume" : "Pause"} readout [S/Esc] Stop [E] Evidence [A] Recovery decision [V]
        Verbosity [:] Command
      </Text>
    </Box>
  );
}
