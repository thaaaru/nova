import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import type { NovaRuntime } from "../../cli/context.js";
import type { ApplicationTestMap } from "../../domain/index.js";
import { approveJourney } from "../../services/testmap/map-service.js";
import { palette } from "../theme/palette.js";
import { journeyModeLabel } from "../services/testmap-view-model.js";

type ExploreMapScreenProps = {
  runtime: NovaRuntime;
  map: ApplicationTestMap;
  onMapChanged: () => void;
  onBack: () => void;
};

type Row = { kind: "area"; areaId: string } | { kind: "journey"; areaId: string; journeyId: string };

const STATUS_COLOR: Record<string, string> = {
  draft: palette.amber,
  approved: palette.green,
  deprecated: palette.muted,
};

/**
 * "Explore and update application map" — a read-only tree view of
 * areas -> journeys, plus an in-place approve action for a draft journey
 * (calls `mapService.approveJourney` only). This is the map-curation
 * surface for this MVP; it does not need a full editor.
 */
export function ExploreMapScreen({
  runtime,
  map,
  onMapChanged,
  onBack,
}: ExploreMapScreenProps): React.ReactElement {
  const rows: Row[] = map.areas.flatMap((area) => [
    { kind: "area" as const, areaId: area.id },
    ...area.journeys.map((journey) => ({ kind: "journey" as const, areaId: area.id, journeyId: journey.id })),
  ]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((index) => Math.max(0, index - 1));
    }
    if (key.downArrow) {
      setSelectedIndex((index) => Math.min(rows.length - 1, index + 1));
    }
    if (input === "a") {
      const row = rows[selectedIndex];
      if (row?.kind === "journey") {
        const area = map.areas.find((candidate) => candidate.id === row.areaId);
        const journey = area?.journeys.find((candidate) => candidate.id === row.journeyId);
        if (journey?.status === "draft") {
          approveJourney(runtime, map.id, row.journeyId);
          onMapChanged();
        }
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        EXPLORE AND UPDATE APPLICATION MAP — {map.applicationName}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {map.areas.map((area) => (
          <Box key={area.id} flexDirection="column">
            {renderAreaRow(area, rows, selectedIndex)}
            {area.journeys.map((journey) => renderJourneyRow(area.id, journey, rows, selectedIndex))}
          </Box>
        ))}
      </Box>
      <Text color={palette.muted}>[up/down] Navigate [A] Approve draft journey [Esc] Back</Text>
    </Box>
  );
}

function renderAreaRow(
  area: ApplicationTestMap["areas"][number],
  rows: Row[],
  selectedIndex: number,
): React.ReactElement {
  const rowIndex = rows.findIndex((row) => row.kind === "area" && row.areaId === area.id);
  const isSelected = rowIndex === selectedIndex;
  return (
    <Text bold color={isSelected ? palette.cyan : palette.foreground}>
      {isSelected ? "> " : "  "}
      {area.name} ({area.riskLevel} risk)
    </Text>
  );
}

function renderJourneyRow(
  areaId: string,
  journey: ApplicationTestMap["areas"][number]["journeys"][number],
  rows: Row[],
  selectedIndex: number,
): React.ReactElement {
  const rowIndex = rows.findIndex(
    (row) => row.kind === "journey" && row.areaId === areaId && row.journeyId === journey.id,
  );
  const isSelected = rowIndex === selectedIndex;
  return (
    <Text key={journey.id} color={isSelected ? palette.cyan : STATUS_COLOR[journey.status]}>
      {isSelected ? "  > " : "    "}
      {journey.name} — {journeyModeLabel(journey.mode)} — {journey.status}
    </Text>
  );
}
