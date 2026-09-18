/**
 * Nova's terminal palette. These are the only colors any screen/component
 * should reference — never a raw hex/ANSI name inline — so the TUI and the
 * HTML report (src/services/reporting/**) stay visually consistent: cyan/
 * blue for normal active progress, violet for AI-adjacent reasoning/
 * recovery activity, green reserved for a verified pass, amber for
 * warnings/waiting/approval-required, red reserved for confirmed failures
 * or blockers.
 */
export const palette = {
  background: "#0a0e1a",
  foreground: "#e6ebf5",
  muted: "#7d8aa8",
  border: "#2a3a5c",
  cyan: "#4fd6e8",
  blue: "#3d7be0",
  violet: "#9d7bf0",
  green: "#3ecf8e",
  amber: "#e8b64f",
  red: "#e8534f",
} as const;

export type PaletteColor = keyof typeof palette;
