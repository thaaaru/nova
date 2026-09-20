import React, { useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";

import { runApprove, runDiscover, runPlan, runReport, type ExecutionResultSummary } from "../cli/commands.js";
import type { NovaRuntime } from "../cli/context.js";
import { getCurrentRunId } from "../cli/context.js";
import type {
  ApplicationTestMap,
  GuidedSetupInput,
  RunEvent,
  TestRunState,
  VerbosityLevel,
} from "../domain/index.js";
import { confirmRun, getMap, listMaps } from "../services/testmap/map-service.js";
import { GuidedSetupScreen } from "./screens/GuidedSetupScreen.js";
import { DiscoveryScreen } from "./screens/DiscoveryScreen.js";
import { PlanReviewScreen } from "./screens/PlanReviewScreen.js";
import { LiveExecutionScreen } from "./screens/LiveExecutionScreen.js";
import { CompletionScreen } from "./screens/CompletionScreen.js";
import { MapHomeScreen } from "./screens/MapHomeScreen.js";
import { MapDiscoverScreen } from "./screens/MapDiscoverScreen.js";
import { AreaSelectScreen } from "./screens/AreaSelectScreen.js";
import { JourneySelectScreen } from "./screens/JourneySelectScreen.js";
import { TestContextScreen, type SelectedTestContext } from "./screens/TestContextScreen.js";
import { PreRunSummaryScreen } from "./screens/PreRunSummaryScreen.js";
import { DescribeTestScreen } from "./screens/DescribeTestScreen.js";
import { RecommendationsScreen } from "./screens/RecommendationsScreen.js";
import { ExploreMapScreen } from "./screens/ExploreMapScreen.js";
import { FailuresScreen } from "./screens/FailuresScreen.js";
import { CommandBar } from "./command-mode/CommandBar.js";
import { parseCommand } from "./command-mode/parse-command.js";
import { toCommandIntent } from "./command-mode/to-intent.js";
import { buildRunViewModel } from "./services/view-model.js";
import {
  buildMapHomeSummary,
  selectActiveMap,
  type MapHomeMenuOptionId,
} from "./services/testmap-view-model.js";
import { makeEvent } from "./services/make-event.js";
import { openPathWithOsOpener } from "./services/open-path.js";
import { loadTuiSettings, saveTuiSettings } from "./theme/settings.js";
import { palette } from "./theme/palette.js";

type Screen =
  | "home"
  | "guided-setup"
  | "discovery"
  | "plan-review"
  | "live-execution"
  | "completion"
  | "map-discover"
  | "map-area-select"
  | "map-journey-select"
  | "map-context"
  | "map-prerun-summary"
  | "map-describe-test"
  | "map-recommendations"
  | "map-explore"
  | "map-failures";

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
  const [mapsVersion, setMapsVersion] = useState(0);
  const [mapId, setMapId] = useState<string | undefined>(() => selectActiveMap(listMaps(runtime))?.id);
  const [selectedAreaId, setSelectedAreaId] = useState<string | undefined>(undefined);
  const [selectedJourneyId, setSelectedJourneyId] = useState<string | undefined>(undefined);
  const [selectedContext, setSelectedContext] = useState<SelectedTestContext | undefined>(undefined);
  const [journeyExecutor, setJourneyExecutor] = useState<(() => Promise<ExecutionResultSummary>) | undefined>(
    undefined,
  );

  const viewModel = useMemo(
    () => buildRunViewModel(run, settings.verbosity, events),
    [run, settings.verbosity, events],
  );

  const activeMap: ApplicationTestMap | undefined = useMemo(
    () => (mapId ? getMap(runtime, mapId) : selectActiveMap(listMaps(runtime))),
    [runtime, mapId, mapsVersion],
  );
  const mapHomeSummary = useMemo(() => buildMapHomeSummary(activeMap), [activeMap]);
  const selectedJourney = useMemo(
    () =>
      activeMap?.areas.flatMap((area) => area.journeys).find((journey) => journey.id === selectedJourneyId),
    [activeMap, selectedJourneyId],
  );

  function refreshMaps(): void {
    setMapsVersion((tick) => tick + 1);
  }

  function handleMapHomeSelect(optionId: MapHomeMenuOptionId): void {
    if (optionId === "discover-app") {
      setScreen("map-discover");
      return;
    }
    if (optionId === "command-mode") {
      setCommandOpen(true);
      return;
    }
    if (optionId === "failures") {
      setScreen("map-failures");
      return;
    }
    if (optionId === "reports") {
      const mostRecentRun = runtime.repository.list()[0];
      if (!mostRecentRun) {
        setCommandOutput(["No run to report on yet."]);
        return;
      }
      const written = runReport(runtime, { run: mostRecentRun.runId });
      openPathWithOsOpener(written.htmlPath);
      setCommandOutput([`HTML report: ${written.htmlPath}`]);
      return;
    }
    if (!activeMap) {
      // Every remaining option needs a map — send the operator straight
      // into discovery instead of dead-ending on a message that names a
      // shell command they would have to leave the TUI to run.
      setScreen("map-discover");
      return;
    }
    if (optionId === "test-area") {
      setScreen("map-area-select");
    } else if (optionId === "describe-test") {
      setScreen("map-describe-test");
    } else if (optionId === "recommendations") {
      setScreen("map-recommendations");
    } else if (optionId === "explore-map") {
      setScreen("map-explore");
    }
  }

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
        <MapHomeScreen
          summary={mapHomeSummary}
          currentRunViewModel={viewModel.runId ? viewModel : undefined}
          onSelect={handleMapHomeSelect}
          onQuit={exit}
          inputActive={!commandOpen}
        />
      ) : null}

      {screen === "map-discover" ? (
        <MapDiscoverScreen
          runtime={runtime}
          onComplete={(map) => {
            setMapId(map.id);
            refreshMaps();
            setScreen("map-explore");
          }}
          onCancel={() => setScreen("home")}
        />
      ) : null}

      {screen === "map-area-select" && activeMap ? (
        <AreaSelectScreen
          map={activeMap}
          onSelect={(areaId) => {
            setMapId(activeMap.id);
            setSelectedAreaId(areaId);
            setScreen("map-journey-select");
          }}
          onBack={() => setScreen("home")}
        />
      ) : null}

      {screen === "map-journey-select" && activeMap && selectedAreaId ? (
        <JourneySelectScreen
          map={activeMap}
          areaId={selectedAreaId}
          onSelect={(journeyId) => {
            setSelectedJourneyId(journeyId);
            setScreen("map-context");
          }}
          onBack={() => setScreen("map-area-select")}
        />
      ) : null}

      {screen === "map-context" && activeMap && selectedJourney ? (
        <TestContextScreen
          map={activeMap}
          journey={selectedJourney}
          onConfirm={(context) => {
            setSelectedContext(context);
            setScreen("map-prerun-summary");
          }}
          onBack={() => setScreen("map-journey-select")}
        />
      ) : null}

      {screen === "map-prerun-summary" && activeMap && selectedJourney && selectedContext ? (
        <PreRunSummaryScreen
          runtime={runtime}
          map={activeMap}
          journey={selectedJourney}
          context={selectedContext}
          verbosity={settings.verbosity}
          onQuickRunComplete={(finalRun) => {
            setRun(finalRun);
            refreshMaps();
            setScreen("completion");
          }}
          onReadyToConfirm={(runId) => {
            const staged = runtime.repository.get(runId);
            if (staged) {
              setRun(staged);
              setJourneyExecutor(
                () => () => confirmRun(runtime, runId, process.env.NOVA_REVIEWER ?? "tui-operator"),
              );
              setExecutionPaused(false);
              setScreen("live-execution");
            }
          }}
          onBack={() => setScreen("map-journey-select")}
        />
      ) : null}

      {screen === "map-describe-test" && activeMap ? (
        <DescribeTestScreen
          runtime={runtime}
          map={activeMap}
          onProceedToMatch={(areaId, journeyId) => {
            setSelectedAreaId(areaId);
            setSelectedJourneyId(journeyId);
            setScreen("map-context");
          }}
          onBack={() => setScreen("home")}
        />
      ) : null}

      {screen === "map-recommendations" && activeMap ? (
        <RecommendationsScreen
          runtime={runtime}
          map={activeMap}
          onSelectJourney={(areaId, journeyId) => {
            setSelectedAreaId(areaId);
            setSelectedJourneyId(journeyId);
            setScreen("map-context");
          }}
          onBack={() => setScreen("home")}
        />
      ) : null}

      {screen === "map-explore" && activeMap ? (
        <ExploreMapScreen
          runtime={runtime}
          map={activeMap}
          onMapChanged={refreshMaps}
          onBack={() => setScreen("home")}
        />
      ) : null}

      {screen === "map-failures" ? (
        <FailuresScreen runtime={runtime} onBack={() => setScreen("home")} />
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
          executor={journeyExecutor}
          onComplete={(finalRun) => {
            setRun(finalRun);
            setJourneyExecutor(undefined);
            refreshMaps();
            setScreen("completion");
          }}
          onStop={() => {
            setJourneyExecutor(undefined);
            setScreen("home");
          }}
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
