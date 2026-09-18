import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

import { palette } from "../theme/palette.js";
import { suggestCommands } from "./command-specs.js";

type CommandBarProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  errorMessage?: string;
};

/** The bottom `:`-mode input line, with prefix-matched autocomplete suggestions shown above it. */
export function CommandBar({ value, onChange, onSubmit, errorMessage }: CommandBarProps): React.ReactElement {
  const suggestions = suggestCommands(value);

  return (
    <Box flexDirection="column">
      {value.length > 0 && suggestions.length > 0 && suggestions.length < 10 ? (
        <Text color={palette.muted}>{suggestions.map((name) => `:${name}`).join("  ")}</Text>
      ) : null}
      <Box borderStyle="single" borderColor={palette.cyan} paddingX={1}>
        <Text color={palette.cyan}>:</Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
      {errorMessage ? <Text color={palette.red}>{errorMessage}</Text> : null}
    </Box>
  );
}
