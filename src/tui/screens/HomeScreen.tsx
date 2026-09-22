import React, { useState } from "react";
import { Box, useInput } from "ink";

import type { NextAction, RunViewModel } from "../../domain/index.js";
import { Header } from "../components/Header.js";
import { StageTracker } from "../components/StageTracker.js";
import { NextActionList } from "../components/NextActionList.js";
import { LiveContextPanel } from "../components/LiveContextPanel.js";
import { KeyHintBar } from "../components/KeyHintBar.js";
import { useTerminalSize, NARROW_WIDTH_COLUMNS } from "../hooks/useTerminalSize.js";

type HomeScreenProps = {
  viewModel: RunViewModel;
  animationEnabled: boolean;
  onSelectAction: (action: NextAction) => void;
  onOpenGuidedSetup: () => void;
  onOpenVerbosity: () => void;
  onOpenCommandMode: () => void;
  onQuit: () => void;
  /** Overrides the measured terminal width — used by tests to assert narrow/wide layouts deterministically. */
  columnsOverride?: number;
  /** False while the `:`-mode command bar owns keyboard input, so keystrokes are never handled twice. */
  inputActive?: boolean;
};

const HOME_KEY_HINTS = [
  { key: "Enter", label: "Select" },
  { key: "up/down", label: "Navigate" },
  { key: "V", label: "Verbosity" },
  { key: ":", label: "Command" },
  { key: "Q", label: "Quit" },
];

/**
 * Home/Run overview: boxed header, FLOW stage tracker, a two-pane body
 * (NEXT SAFE ACTION / LIVE CONTEXT) that stacks vertically below
 * NARROW_WIDTH_COLUMNS, and the bottom key-hint bar.
 */
export function HomeScreen({
  viewModel,
  animationEnabled,
  onSelectAction,
  onOpenGuidedSetup,
  onOpenVerbosity,
  onOpenCommandMode,
  onQuit,
  columnsOverride,
  inputActive = true,
}: HomeScreenProps): React.ReactElement {
  const { columns: measuredColumns } = useTerminalSize();
  const columns = columnsOverride ?? measuredColumns;
  const isNarrow = columns < NARROW_WIDTH_COLUMNS;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const actions = viewModel.nextActions;

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setSelectedIndex((index) => Math.max(0, index - 1));
      }
      if (key.downArrow) {
        setSelectedIndex((index) => Math.min(Math.max(0, actions.length - 1), index + 1));
      }
      if (key.return) {
        const action = actions[selectedIndex];
        if (!action) {
          return;
        }
        if (action.id === "guided-setup") {
          onOpenGuidedSetup();
        } else {
          onSelectAction(action);
        }
      }
      if (input === "v" || input === "V") {
        onOpenVerbosity();
      }
      if (input === ":") {
        onOpenCommandMode();
      }
      if (input === "q" || input === "Q") {
        onQuit();
      }
    },
    { isActive: inputActive },
  );

  return (
    <Box flexDirection="column">
      <Header viewModel={viewModel} />
      <Box paddingX={1} marginY={1}>
        <StageTracker currentStage={viewModel.currentStage} />
      </Box>
      <Box flexDirection={isNarrow ? "column" : "row"} gap={1} paddingX={1}>
        <NextActionList actions={actions} blockers={viewModel.blockers} selectedIndex={selectedIndex} />
        <LiveContextPanel viewModel={viewModel} />
      </Box>
      <KeyHintBar hints={HOME_KEY_HINTS} />
    </Box>
  );
}
