import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";

import type { ApplicationTestMap, UserJourney } from "../../domain/index.js";
import { palette } from "../theme/palette.js";
import { journeyModeLabel } from "../services/testmap-view-model.js";

export type SelectedTestContext = {
  environment: string;
  personaId?: string;
  fixtureIds: string[];
};

type TestContextScreenProps = {
  map: ApplicationTestMap;
  journey: UserJourney;
  onConfirm: (context: SelectedTestContext) => void;
  onBack: () => void;
};

/**
 * Step 3 of "Test an application area": environment is fixed by the map
 * (there is no cross-environment selection in this MVP — see
 * validateJourneyRunContext in journey-run-service.ts), persona choices
 * are limited to journey.requiredPersonaIds, and every required fixture
 * is included automatically (they are mandatory, not optional — a
 * journey's requiredFixtureIds must *all* be present, so there is nothing
 * to "choose" among fixtures). A field's prompt is skipped entirely when
 * its requirement list is empty.
 */
export function TestContextScreen({
  map,
  journey,
  onConfirm,
  onBack,
}: TestContextScreenProps): React.ReactElement {
  const personaOptions = journey.requiredPersonaIds
    .map((personaId) => map.personas.find((candidate) => candidate.id === personaId))
    .filter((persona): persona is NonNullable<typeof persona> => Boolean(persona));
  const fixtureNames = journey.requiredFixtureIds.map(
    (fixtureId) => map.fixtures.find((candidate) => candidate.id === fixtureId)?.name ?? fixtureId,
  );

  const needsPersonaChoice = personaOptions.length > 1;
  const [personaId, setPersonaId] = useState<string | undefined>(
    needsPersonaChoice ? undefined : personaOptions[0]?.id,
  );

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
    }
    if (key.return && personaId !== undefined) {
      confirm();
    }
    if (key.return && personaOptions.length === 0) {
      confirm();
    }
  });

  function confirm(): void {
    onConfirm({ environment: map.environment, personaId, fixtureIds: [...journey.requiredFixtureIds] });
  }

  const selectedPersonaName = personaOptions.find((persona) => persona.id === personaId)?.name;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        TEST CONTEXT — {journey.name}
      </Text>
      {needsPersonaChoice && !personaId ? (
        <Box flexDirection="column">
          <Text>Select a persona (this journey allows any of the following):</Text>
          <SelectInput
            items={personaOptions.map((persona) => ({ label: persona.name, value: persona.id }))}
            onSelect={(item) => setPersonaId(item.value)}
          />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={palette.blue}>
            SUMMARY
          </Text>
          <Text>
            <Text color={palette.muted}>Environment: </Text>
            {map.environment} <Text color={palette.muted}>(fixed by the application test map)</Text>
          </Text>
          <Text>
            <Text color={palette.muted}>Persona: </Text>
            {selectedPersonaName ?? "No persona required"}
          </Text>
          <Text>
            <Text color={palette.muted}>Fixture: </Text>
            {fixtureNames.length > 0 ? fixtureNames.join(", ") : "No fixtures required"}
          </Text>
          <Text>
            <Text color={palette.muted}>Mode: </Text>
            {journeyModeLabel(journey.mode)}
          </Text>
          <Text color={palette.muted}>[Enter] Continue [Esc] Back</Text>
        </Box>
      )}
    </Box>
  );
}
