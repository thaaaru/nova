/**
 * The exhaustive list of `:`-mode commands. `requiredFlags` are `--name`
 * style flags; `positional` names bind the first N bare tokens (used by
 * `:verbosity <level>` and `:animation <on|off>`, which read more
 * naturally without a `--` flag). `allowedValues`, when present, restricts
 * a single positional argument to an enum and is what the parser's error
 * message quotes back to the operator.
 */
export type CommandSpec = {
  name: string;
  description: string;
  requiredFlags: string[];
  positional: string[];
  allowedValues?: Record<string, string[]>;
};

export const COMMAND_SPECS: CommandSpec[] = [
  { name: "help", description: "List every command.", requiredFlags: [], positional: [] },
  { name: "status", description: "Show the current run's status.", requiredFlags: [], positional: [] },
  { name: "runs", description: "List every persisted run.", requiredFlags: [], positional: [] },
  {
    name: "discover",
    description: "Crawl a target and capture a read-only application map.",
    requiredFlags: ["target"],
    positional: [],
  },
  {
    name: "plan",
    description: "Generate a reviewable TestPlan from a discovered run.",
    requiredFlags: ["objective"],
    positional: [],
  },
  {
    name: "approve",
    description: "Approve a TestPlan by id.",
    requiredFlags: ["plan"],
    positional: [],
  },
  {
    name: "run",
    description: "Execute an approved TestPlan's cases, then verify and report.",
    requiredFlags: ["plan"],
    positional: [],
  },
  {
    name: "pause",
    description: "Best-effort: stop advancing the simulated progress readout after the current action.",
    requiredFlags: [],
    positional: [],
  },
  {
    name: "resume",
    description: "Best-effort: resume the simulated progress readout.",
    requiredFlags: [],
    positional: [],
  },
  {
    name: "stop",
    description: "Best-effort: return to Home without opening verify/report screens automatically.",
    requiredFlags: [],
    positional: [],
  },
  {
    name: "report",
    description: "(Re)generate JSON, JUnit, and HTML reports for a run.",
    requiredFlags: ["run"],
    positional: [],
  },
  {
    name: "artifacts",
    description: "Open the artifacts directory for a run.",
    requiredFlags: ["run"],
    positional: [],
  },
  {
    name: "verbosity",
    description: "Set the event-feed verbosity level.",
    requiredFlags: [],
    positional: ["level"],
    allowedValues: { level: ["executive", "standard", "diagnostic"] },
  },
  {
    name: "animation",
    description: "Turn the active-stage pulse animation on or off.",
    requiredFlags: [],
    positional: ["value"],
    allowedValues: { value: ["on", "off"] },
  },
  {
    name: "json",
    description: "Show the current run's raw TestRunState JSON.",
    requiredFlags: [],
    positional: [],
  },
  { name: "clear", description: "Clear the event feed.", requiredFlags: [], positional: [] },
];

export const COMMAND_NAMES: string[] = COMMAND_SPECS.map((spec) => spec.name);

/**
 * Prefix-matches command names as the operator types after `:` — no fuzzy
 * matching, just `startsWith`, which is sufficient for a list this short.
 */
export function suggestCommands(prefix: string): string[] {
  const normalized = prefix.replace(/^:/, "").toLowerCase();
  if (normalized.length === 0) {
    return COMMAND_NAMES;
  }
  return COMMAND_NAMES.filter((name) => name.startsWith(normalized));
}
