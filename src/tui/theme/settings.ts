import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { NovaConfig } from "../../config/index.js";
import type { VerbosityLevel } from "../../domain/index.js";

/**
 * Local TUI-only preferences (animation on/off, last-chosen verbosity).
 * Persisted as a sibling of the existing "current run" convenience pointer
 * (src/cli/context.ts's currentRunPointerPath) inside the same data
 * directory that already holds NovaConfig's databasePath — no new config
 * location is introduced.
 */
export type TuiSettings = {
  animation: boolean;
  verbosity: VerbosityLevel;
};

const DEFAULT_SETTINGS: TuiSettings = {
  animation: true,
  verbosity: "standard",
};

function settingsPath(config: NovaConfig): string {
  return join(dirname(config.databasePath), "tui-settings.json");
}

export function loadTuiSettings(config: NovaConfig): TuiSettings {
  const path = settingsPath(config);
  if (!existsSync(path)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TuiSettings>;
    return {
      animation: typeof parsed.animation === "boolean" ? parsed.animation : DEFAULT_SETTINGS.animation,
      verbosity:
        parsed.verbosity === "executive" ||
        parsed.verbosity === "standard" ||
        parsed.verbosity === "diagnostic"
          ? parsed.verbosity
          : DEFAULT_SETTINGS.verbosity,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveTuiSettings(config: NovaConfig, settings: TuiSettings): void {
  const path = settingsPath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2));
}
