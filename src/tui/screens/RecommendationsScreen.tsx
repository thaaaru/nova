import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";

import type { NovaRuntime } from "../../cli/context.js";
import type { ApplicationTestMap } from "../../domain/index.js";
import { recommendations } from "../../services/testmap/map-service.js";
import type { RegressionRecommendation } from "../../services/testmap/recommendation-service.js";
import { palette } from "../theme/palette.js";
import { findJourneyArea } from "../services/testmap-view-model.js";

type RecommendationsScreenProps = {
  runtime: NovaRuntime;
  map: ApplicationTestMap;
  onSelectJourney: (areaId: string, journeyId: string) => void;
  onBack: () => void;
};

/**
 * "Run recommended regression tests" — calls `mapService.recommendations`
 * only (deterministic risk + last-run-outcome/staleness ranking; never a
 * model). Rendered exactly in the product spec's numbered format, e.g.
 * "1. Registered customer checkout — High risk — Last run failed".
 */
export function RecommendationsScreen({
  runtime,
  map,
  onSelectJourney,
  onBack,
}: RecommendationsScreenProps): React.ReactElement {
  const [recs, setRecs] = useState<RegressionRecommendation[] | undefined>(undefined);

  useEffect(() => {
    void recommendations(runtime, map.id).then(setRecs);
  }, [runtime, map.id]);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  if (!recs) {
    return (
      <Box borderStyle="round" borderColor={palette.border} paddingX={1}>
        <Text color={palette.cyan}>Computing recommendations…</Text>
      </Box>
    );
  }

  if (recs.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
        <Text color={palette.muted}>No regression recommendations right now — everything is fresh.</Text>
        <Text color={palette.muted}>[Esc] Back</Text>
      </Box>
    );
  }

  const items = recs.map((rec, index) => ({
    label: `${index + 1}. ${rec.journeyName} — ${capitalize(rec.riskLevel)} risk — ${rec.reason}`,
    value: rec.journeyId,
  }));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        RUN RECOMMENDED REGRESSION TESTS
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            const area = findJourneyArea(map, item.value);
            if (area) {
              onSelectJourney(area.id, item.value);
            }
          }}
        />
      </Box>
      <Text color={palette.muted}>[Esc] Back</Text>
    </Box>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
