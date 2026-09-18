import React from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";

import type { ApplicationTestMap } from "../../domain/index.js";
import { palette } from "../theme/palette.js";
import {
  estimateJourneyDurationSeconds,
  formatDurationLabel,
  journeyModeLabel,
  journeyRiskLevel,
  resolveFirstRequiredPersonaName,
} from "../services/testmap-view-model.js";

type JourneySelectScreenProps = {
  map: ApplicationTestMap;
  areaId: string;
  onSelect: (journeyId: string) => void;
  onBack: () => void;
};

/**
 * Step 2 of "Test an application area": lists the selected area's
 * journeys, each row showing mode, risk, first required persona (if any),
 * last run outcome, and an estimated duration — the checkpoints.length *
 * 45s heuristic documented in testmap-view-model.ts, never a real
 * measurement.
 */
export function JourneySelectScreen({
  map,
  areaId,
  onSelect,
  onBack,
}: JourneySelectScreenProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  const area = map.areas.find((candidate) => candidate.id === areaId);

  if (!area || area.journeys.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.amber} paddingX={1}>
        <Text color={palette.amber}>This area has no journeys yet.</Text>
        <Text color={palette.muted}>[Esc] Back</Text>
      </Box>
    );
  }

  const items = area.journeys.map((journey) => {
    const personaName = resolveFirstRequiredPersonaName(map, journey);
    const durationLabel = formatDurationLabel(estimateJourneyDurationSeconds(journey));
    return {
      label:
        `${journey.name} — ${journeyModeLabel(journey.mode)} — ${journeyRiskLevel(journey)} risk — ` +
        `${journey.status} — ` +
        `${personaName ?? "No persona required"} — ` +
        `last run: ${journey.lastRunOutcome ?? "never"} — ${durationLabel}`,
      value: journey.id,
    };
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        {area.name.toUpperCase()} — select a journey
      </Text>
      <Text color={palette.muted}>Area risk: {area.riskLevel}</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => onSelect(item.value)} />
      </Box>
      <Text color={palette.muted}>[Esc] Back</Text>
    </Box>
  );
}
