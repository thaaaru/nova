import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

import type { NovaRuntime } from "../../cli/context.js";
import type { ApplicationTestMap } from "../../domain/index.js";
import { describeTest } from "../../services/testmap/map-service.js";
import type { NaturalLanguageMatch } from "../../services/testmap/nl-match-service.js";
import { palette } from "../theme/palette.js";

type DescribeTestScreenProps = {
  runtime: NovaRuntime;
  map: ApplicationTestMap;
  onProceedToMatch: (areaId: string, journeyId: string) => void;
  onBack: () => void;
};

/**
 * "Describe a test" — calls `mapService.describeTest` only (deterministic
 * keyword-overlap matching, never an LLM). A close match hands off to the
 * existing pre-run summary flow for that journey; a draft never offers a
 * run action, since a draft journey has no real steps and is
 * intentionally unapproved.
 */
export function DescribeTestScreen({
  runtime,
  map,
  onProceedToMatch,
  onBack,
}: DescribeTestScreenProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [match, setMatch] = useState<NaturalLanguageMatch | undefined>(undefined);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return && match?.kind === "matched") {
      onProceedToMatch(match.area.id, match.journey.id);
    }
  });

  function submit(text: string): void {
    if (text.trim().length === 0) {
      return;
    }
    setMatch(describeTest(runtime, map.id, text));
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        DESCRIBE A TEST
      </Text>
      {!match ? (
        <>
          <Text>What should Nova test? Describe it in plain language.</Text>
          <TextInput value={value} onChange={setValue} onSubmit={submit} />
        </>
      ) : match.kind === "matched" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.green}>
            This matches an existing test: {match.journey.name} in {match.area.name}
          </Text>
          <Text color={palette.muted}>Match score: {match.score.toFixed(2)}</Text>
          <Text color={palette.cyan}>[Enter] Continue to pre-run summary [Esc] Back</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.amber}>
            No existing approved test matches closely (best match score: {match.bestScore.toFixed(2)}). Nova
            has drafted a guided test outline; a QA engineer must curate concrete steps before it can run.
          </Text>
          <Text bold>{match.draftJourney.name}</Text>
          <Text color={palette.muted}>{match.draftJourney.description}</Text>
          <Text color={palette.muted}>[Esc] Back</Text>
        </Box>
      )}
    </Box>
  );
}
