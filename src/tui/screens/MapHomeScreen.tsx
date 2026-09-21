import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import type { RunViewModel } from "../../domain/index.js";
import { palette } from "../theme/palette.js";
import { KeyHintBar } from "../components/KeyHintBar.js";
import {
  buildMapHomeMenuItems,
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
};

const HOME_KEY_HINTS = [
  { key: "1-7", label: "Select" },
  { key: "Enter", label: "Select" },
  { key: "up/down", label: "Navigate" },
  { key: "V", label: "Verbosity" },
  { key: ":", label: "Command" },
  { key: "Q", label: "Quit" },
];

/**
 * The Application Test Map product's home menu — the TUI's default
 * landing screen (replaces the legacy CLI-flow HomeScreen here; that
 * component and its tests are unchanged and still directly reachable by
 * anything that imports it, e.g. a future "advanced" surface). Every
 * figure in the summary panel comes from `buildMapHomeSummary`, which
 * only reads the active ApplicationTestMap — never a new service call.
 */
export function MapHomeScreen({
  summary,
  currentRunViewModel,
  onSelect,
  onQuit,
  onCycleVerbosity,
  inputActive = true,
}: MapHomeScreenProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuItems = buildMapHomeMenuItems(summary.hasMap);
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
      <KeyHintBar hints={HOME_KEY_HINTS} />
    </Box>
  );
}
