import React, { useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";

import { runApprove, runDiscover, runPlan, runReport } from "../cli/commands.js";
import type { NovaRuntime } from "../cli/context.js";
import { getCurrentRunId } from "../cli/context.js";
import type {
  GuidedSetupInput,
  NextAction,
  RunEvent,
  TestRunState,
  VerbosityLevel,
} from "../domain/index.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { GuidedSetupScreen } from "./screens/GuidedSetupScreen.js";
import { DiscoveryScreen } from "./screens/DiscoveryScreen.js";
import { PlanReviewScreen } from "./screens/PlanReviewScreen.js";
import { LiveExecutionScreen } from "./screens/LiveExecutionScreen.js";
import { CompletionScreen } from "./screens/CompletionScreen.js";
import { CommandBar } from "./command-mode/CommandBar.js";
import { parseCommand } from "./command-mode/parse-command.js";
import { toCommandIntent } from "./command-mode/to-intent.js";
import { buildRunViewModel } from "./services/view-model.js";
import { makeEvent } from "./services/make-event.js";
import { openPathWithOsOpener } from "./services/open-path.js";
import { loadTuiSettings, saveTuiSettings } from "./theme/settings.js";
import { palette } from "./theme/palette.js";

type Screen = "home" | "guided-setup" | "discovery" | "plan-review" | "live-execution" | "completion";

type AppProps = {
  runtime: NovaRuntime;
};

function loadInitialRun(runtime: NovaRuntime): TestRunState | undefined {
  const runId = getCurrentRunId(runtime.config);
  return runId ? runtime.repository.get(runId) : undefined;
}

/**
 * Root Ink component and in-app router/state machine. Every screen below
 * calls the same src/cli/commands.ts functions the CLI uses — this file
 * never reimplements discover/plan/approve/execute/report logic, it only
 * wires the real calls to screen transitions and to the shared event feed.
 */
export function App({ runtime }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("home");
  const [run, setRun] = useState<TestRunState | undefined>(() => loadInitialRun(runtime));
  const [settings, setSettings] = useState(() => loadTuiSettings(runtime.config));
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [guidedSetupInitial, setGuidedSetupInitial] = useState<Partial<GuidedSetupInput> | undefined>(
    undefined,
  );
  const [executionPaused, setExecutionPaused] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandValue, setCommandValue] = useState("");
  const [commandError, setCommandError] = useState<string | undefined>(undefined);
  const [commandOutput, setCommandOutput] = useState<string[]>([]);

  const viewModel = useMemo(
    () => buildRunViewModel(run, settings.verbosity, events),
    [run, settings.verbosity, events],
  );

  function log(
    message: string,
    level: RunEvent["level"] = "info",
    minVerbosity: VerbosityLevel = "standard",
  ): void {
    setEvents((previous) => [
      ...previous,
      makeEvent(viewModel.currentStage ?? "discover", level, minVerbosity, message),
    ]);
  }

  function updateSettings(patch: Partial<typeof settings>): void {
    const updated = { ...settings, ...patch };
    setSettings(updated);
    saveTuiSettings(runtime.config, updated);
  }

  function cycleVerbosity(): void {
    const order: VerbosityLevel[] = ["executive", "standard", "diagnostic"];
    const next = order[(order.indexOf(settings.verbosity) + 1) % order.length] ?? "standard";
    updateSettings({ verbosity: next });
  }

  function refreshRun(runId: string): TestRunState | undefined {
    const updated = runtime.repository.get(runId);
    setRun(updated);
    return updated;
  }

  function handleNextAction(action: NextAction): void {
    setCommandValue(action.command.replace(/^:/, ""));
    setCommandOpen(true);
  }

  function handleGuidedSetupSubmit(input: GuidedSetupInput): void {
    setGuidedSetupInitial(input);
    setScreen("discovery");
  }

  async function runCommandIntent(name: string, args: Record<string, string>): Promise<void> {
    const intent = toCommandIntent(name, args);
    if (!intent) {
      setCommandError(`":${name}" is missing a required argument.`);
      return;
    }
    setCommandError(undefined);
    try {
      switch (intent.type) {
        case "help": {
          setCommandOutput([
            "Commands: :help :status :runs :discover :plan :approve :run :pause :resume :stop :report :artifacts :verbosity :animation :json :clear",
          ]);
          break;
        }
        case "status": {
          setCommandOutput([run ? `Run ${run.runId}: ${run.status}` : "No current run."]);
          break;
        }
        case "runs": {
          const runs = runtime.repository.list();
          setCommandOutput(
            runs.map((entry) => `${entry.runId}  ${entry.status}  ${entry.targetManifest.baseUrl}`),
          );
          break;
        }
        case "discover": {
          const result = await runDiscover(runtime, { target: intent.target });
          const updated = refreshRun(result.runId);
          log(`Discovered ${result.pageCount} page(s) at ${intent.target}`, "info", "standard");
          setCommandOutput([`Run ${result.runId}: discovered ${result.pageCount} page(s).`]);
          if (updated) {
            setScreen("home");
          }
          break;
        }
        case "plan": {
          const result = await runPlan(runtime, { objective: intent.objective });
          refreshRun(result.runId);
          log(`Plan ${result.planId} ready for review: ${result.cases.length} case(s).`, "info", "standard");
          setCommandOutput([`Plan ${result.planId} ready for review: ${result.cases.length} case(s).`]);
          break;
        }
        case "approve": {
          const result = await runApprove(runtime, { plan: intent.planId });
          refreshRun(result.runId);
          log(
            `Plan ${result.runId} ${result.decision}.`,
            result.decision === "approved" ? "approval" : "warning",
            "executive",
          );
          setCommandOutput([`Plan ${result.runId} ${result.decision}.`]);
          break;
        }
        case "run": {
          const target = runtime.repository.get(intent.planId);
          if (!target) {
            setCommandError(`Unknown plan: ${intent.planId}`);
            break;
          }
          setRun(target);
          setExecutionPaused(false);
          setScreen("live-execution");
          setCommandOutput([`Executing plan ${intent.planId}…`]);
          break;
        }
        case "pause": {
          setExecutionPaused(true);
          setCommandOutput([
            "Simulated progress readout paused (the in-flight run itself cannot be paused).",
          ]);
          break;
        }
        case "resume": {
          setExecutionPaused(false);
          setCommandOutput(["Simulated progress readout resumed."]);
          break;
        }
        case "stop": {
          setScreen("home");
          setCommandOutput(["Returned to Home — will not auto-open verify/report for the in-flight run."]);
          break;
        }
        case "report": {
          const written = runReport(runtime, { run: intent.runId });
          setCommandOutput([
            `JSON: ${written.jsonPath}`,
            `JUnit: ${written.junitPath}`,
            `HTML: ${written.htmlPath}`,
          ]);
          break;
        }
        case "artifacts": {
          const artifactsDir = `${runtime.config.artifactsDirectory}/${intent.runId}`;
          openPathWithOsOpener(artifactsDir);
          setCommandOutput([`Artifacts folder: ${artifactsDir}`]);
          break;
        }
        case "verbosity": {
          updateSettings({ verbosity: intent.level });
          setCommandOutput([`Verbosity set to ${intent.level}.`]);
          break;
        }
        case "animation": {
          updateSettings({ animation: intent.on });
          setCommandOutput([`Animation turned ${intent.on ? "on" : "off"}.`]);
          break;
        }
        case "json": {
          setCommandOutput(run ? JSON.stringify(run, null, 2).split("\n") : ["No current run."]);
          break;
        }
        case "clear": {
          setEvents([]);
          setCommandOutput(["Event feed cleared."]);
          break;
        }
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleCommandSubmit(value: string): void {
    const parsed = parseCommand(value);
    if (!parsed.ok) {
      setCommandError(parsed.error);
      return;
    }
    setCommandValue("");
    void runCommandIntent(parsed.name, parsed.args);
  }

  return (
    <Box flexDirection="column">
      {screen === "home" ? (
        <HomeScreen
          viewModel={viewModel}
          animationEnabled={settings.animation}
          onSelectAction={handleNextAction}
          onOpenGuidedSetup={() => {
            setGuidedSetupInitial(undefined);
            setScreen("guided-setup");
          }}
          onOpenVerbosity={cycleVerbosity}
          onOpenCommandMode={() => setCommandOpen(true)}
          onQuit={exit}
          inputActive={!commandOpen}
        />
      ) : null}

      {screen === "guided-setup" ? (
        <GuidedSetupScreen
          initial={guidedSetupInitial}
          onSubmit={handleGuidedSetupSubmit}
          onCancel={() => setScreen("home")}
        />
      ) : null}

      {screen === "discovery" && guidedSetupInitial?.targetUrl ? (
        <DiscoveryScreen
          runtime={runtime}
          input={guidedSetupInitial as GuidedSetupInput}
          onComplete={(runId) => {
            refreshRun(runId);
            setScreen("plan-review");
          }}
          onCancel={() => setScreen("home")}
        />
      ) : null}

      {screen === "plan-review" && run ? (
        <PlanReviewScreen
          runtime={runtime}
          run={run}
          onApproved={() => {
            refreshRun(run.runId);
            setScreen("home");
          }}
          onRejected={() => {
            refreshRun(run.runId);
            setScreen("home");
          }}
          onReturnToPlanning={() => {
            setGuidedSetupInitial({
              projectName: run.targetManifest.description || run.targetManifest.targetId,
              environment: run.targetManifest.environment,
              targetUrl: run.targetManifest.baseUrl,
              allowedDomains: run.targetManifest.allowedDomains,
              runExecutionMode: run.targetManifest.runExecutionMode,
              objective: run.objective ?? "",
            });
            setScreen("guided-setup");
          }}
          onBack={() => setScreen("home")}
        />
      ) : null}

      {screen === "live-execution" && run ? (
        <LiveExecutionScreen
          runtime={runtime}
          run={run}
          verbosity={settings.verbosity}
          paused={executionPaused}
          onTogglePause={() => setExecutionPaused((value) => !value)}
          onComplete={(finalRun) => {
            setRun(finalRun);
            setScreen("completion");
          }}
          onStop={() => setScreen("home")}
          onCycleVerbosity={cycleVerbosity}
          onOpenCommandMode={() => setCommandOpen(true)}
          inputActive={!commandOpen}
        />
      ) : null}

      {screen === "completion" && run ? (
        <CompletionScreen
          runtime={runtime}
          run={run}
          onBeginNewRun={() => {
            setGuidedSetupInitial({
              projectName: run.targetManifest.description || run.targetManifest.targetId,
              environment: run.targetManifest.environment,
              targetUrl: run.targetManifest.baseUrl,
              allowedDomains: run.targetManifest.allowedDomains,
              runExecutionMode: run.targetManifest.runExecutionMode,
              objective: run.objective ?? "",
            });
            setScreen("guided-setup");
          }}
          onBack={() => setScreen("home")}
        />
      ) : null}

      {commandOutput.length > 0 && !commandOpen ? (
        <Box flexDirection="column" borderStyle="single" borderColor={palette.border} paddingX={1}>
          {commandOutput.slice(0, 20).map((line, index) => (
            <Text key={index} color={palette.muted}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {commandOpen ? (
        <CommandBar
          value={commandValue}
          onChange={setCommandValue}
          onSubmit={(value) => {
            handleCommandSubmit(value);
            setCommandOpen(false);
          }}
          errorMessage={commandError}
        />
      ) : null}
    </Box>
  );
}
