import React from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";

import type { ApplicationTestMap } from "../../domain/index.js";
import { palette } from "../theme/palette.js";
import { buildAreaSummaries } from "../services/testmap-view-model.js";

type AreaSelectScreenProps = {
  map: ApplicationTestMap;
  onSelect: (areaId: string) => void;
  onBack: () => void;
};

/**
 * Step 1 of "Test an application area": lists every area on the active
 * map with its risk level plus approved-journey/recent-failure counts,
 * both folded client-side from the area's own already-fetched journeys
 * (see buildAreaSummaries) — no new map-service function.
 */
export function AreaSelectScreen({ map, onSelect, onBack }: AreaSelectScreenProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  const areas = buildAreaSummaries(map);

  if (areas.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.amber} paddingX={1}>
        <Text color={palette.amber}>This map has no application areas yet.</Text>
        <Text color={palette.muted}>[Esc] Back</Text>
      </Box>
    );
  }

  const items = areas.map((area) => ({
    label: `${area.name} — ${area.riskLevel} risk — ${area.approvedJourneyCount} approved journey(s) — ${area.recentFailureCount} recent failure(s)`,
    value: area.id,
  }));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        TEST AN APPLICATION AREA — select an area
      </Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => onSelect(item.value)} />
      </Box>
      <Text color={palette.muted}>[Esc] Back</Text>
    </Box>
  );
}
