import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import type { RunViewModel } from "../../domain/index.js";
import { palette } from "../theme/palette.js";
import { KeyHintBar } from "../components/KeyHintBar.js";
import { StageTracker } from "../components/StageTracker.js";
import {
  buildMapHomeMenuItems,
  recommendedFlowStage,
  recommendedMenuOptionId,
  type MapHomeMenuOptionId,
  type MapHomeSummary,
} from "../services/testmap-view-model.js";

type MapHomeScreenProps = {
  summary: MapHomeSummary;
  /** Optional legacy CLI-flow status line — preserves the existing "current run" panel where one exists. */
  currentRunViewModel?: RunViewModel;
  onSelect: (optionId: MapHomeMenuOptionId) => void;
  onQuit: () => void;
  onCycleVerbosity: () => void;
  /** False while the `:`-mode command bar owns keyboard input. */
  inputActive?: boolean;
  animationEnabled?: boolean;
};

function buildKeyHints(primaryLabel: string, optionCount: number): Array<{ key: string; label: string }> {
  return [
    { key: "Enter", label: primaryLabel },
    { key: `1-${optionCount}`, label: "Other actions" },
    { key: "up/down", label: "Navigate" },
    { key: "V", label: "Verbosity" },
    { key: ":", label: "Command" },
    { key: "Q", label: "Quit" },
  ];
}

/**
 * The Application Test Map product's home menu — the TUI's default
 * landing screen (replaces the legacy CLI-flow HomeScreen here; that
 * component and its tests are unchanged and still directly reachable by
 * anything that imports it, e.g. a future "advanced" surface). Every
 * figure in the summary panel comes from `buildMapHomeSummary`, which
 * only reads the active ApplicationTestMap — never a new service call.
 *
 * One primary action per screen (per the product spec): the stage
 * tracker and the cursor's starting position both point at
 * `recommendedMenuOptionId`, so Enter runs the safest logical next step
 * without requiring the operator to read the full numbered list first.
 * The list itself stays reachable for every other action — progressive
 * disclosure, not a hidden flow.
 */
export function MapHomeScreen({
  summary,
  currentRunViewModel,
  onSelect,
  onQuit,
  onCycleVerbosity,
  inputActive = true,
  animationEnabled = true,
}: MapHomeScreenProps): React.ReactElement {
  const menuItems = buildMapHomeMenuItems(summary.hasMap);
  const recommendedOptionId = recommendedMenuOptionId(summary);
  const recommendedIndex = Math.max(
    0,
    menuItems.findIndex((item) => item.id === recommendedOptionId),
  );
  const [selectedIndex, setSelectedIndex] = useState(recommendedIndex);
  const primaryLabel = menuItems[selectedIndex]?.label ?? "Select";
  const stage = recommendedFlowStage(summary);
  useInput(
    (input, key) => {
      if (key.upArrow) {
        setSelectedIndex((index) => Math.max(0, index - 1));
      }
      if (key.downArrow) {
        setSelectedIndex((index) => Math.min(menuItems.length - 1, index + 1));
      }
      if (key.return) {
        onSelect(menuItems[selectedIndex].id);
      }
      const digit = Number(input);
      if (Number.isInteger(digit) && digit >= 1 && digit <= menuItems.length) {
        onSelect(menuItems[digit - 1].id);
      }
      if (input === "q" || input === "Q") {
        onQuit();
      }
      if (input === "v" || input === "V") {
        onCycleVerbosity();
      }
    },
    { isActive: inputActive },
  );

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={palette.border} paddingX={1}>
        <Text bold color={palette.cyan}>
          {summary.hasMap
            ? `NOVA — ${summary.applicationName} / ${summary.environment}`
            : "NOVA — APPLICATION TEST MAP"}
        </Text>
      </Box>
      <Box marginTop={1}>
        <StageTracker currentStage={stage} />
      </Box>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={palette.border}
        paddingX={1}
        marginTop={1}
      >
        {menuItems.map((item, index) => (
          <Text
            key={item.id}
            color={index === selectedIndex ? palette.cyan : palette.foreground}
            bold={index === selectedIndex}
          >
            {index === selectedIndex ? "> " : "  "}
            {item.number}. {item.label}
          </Text>
        ))}
      </Box>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={palette.border}
        paddingX={1}
        marginTop={1}
      >
        <Text bold color={palette.blue}>
          APPLICATION
        </Text>
        {!summary.hasMap ? (
          <Text color={palette.amber}>{summary.noMapMessage}</Text>
        ) : (
          <>
            <Text>
              <Text color={palette.muted}>Environment: </Text>
              {summary.environment}
            </Text>
            <Text>
              <Text color={palette.muted}>Policy: </Text>
              {summary.executionModeLabel}
            </Text>
            <Text>
              <Text color={palette.muted}>Latest run: </Text>
              {summary.latestRunOutcome ?? "No runs yet"}
            </Text>
            <Text>
              <Text color={palette.muted}>Approved journeys: </Text>
              {summary.approvedJourneyCount}
            </Text>
          </>
        )}
        {currentRunViewModel?.runId ? (
          <Text color={palette.muted}>
            Current CLI-flow run: {currentRunViewModel.runId.slice(0, 8)} — {currentRunViewModel.status}
          </Text>
        ) : null}
      </Box>
      <KeyHintBar hints={buildKeyHints(primaryLabel, menuItems.length)} />
    </Box>
  );
}
