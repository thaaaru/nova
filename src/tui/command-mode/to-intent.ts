import type { VerbosityLevel } from "../../domain/index.js";

/**
 * Typed shape App.tsx switches on, derived from a successfully parsed
 * `:`-mode command. Kept separate from `CommandParseResult` (which must
 * stay the generic `{ ok, name, args }` shape from domain/schemas/tui.ts)
 * so the dispatcher gets exhaustive-switch safety instead of stringly-typed
 * `args` lookups scattered through App.
 */
export type CommandIntent =
  | { type: "help" }
  | { type: "status" }
  | { type: "runs" }
  | { type: "discover"; target: string }
  | { type: "plan"; objective: string }
  | { type: "approve"; planId: string }
  | { type: "run"; planId: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "report"; runId: string }
  | { type: "artifacts"; runId: string }
  | { type: "verbosity"; level: VerbosityLevel }
  | { type: "animation"; on: boolean }
  | { type: "json" }
  | { type: "clear" };

export function toCommandIntent(name: string, args: Record<string, string>): CommandIntent | undefined {
  switch (name) {
    case "help":
      return { type: "help" };
    case "status":
      return { type: "status" };
    case "runs":
      return { type: "runs" };
    case "discover":
      return args.target ? { type: "discover", target: args.target } : undefined;
    case "plan":
      return args.objective ? { type: "plan", objective: args.objective } : undefined;
    case "approve":
      return args.plan ? { type: "approve", planId: args.plan } : undefined;
    case "run":
      return args.plan ? { type: "run", planId: args.plan } : undefined;
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    case "stop":
      return { type: "stop" };
    case "report":
      return args.run ? { type: "report", runId: args.run } : undefined;
    case "artifacts":
      return args.run ? { type: "artifacts", runId: args.run } : undefined;
    case "verbosity":
      return args.level === "executive" || args.level === "standard" || args.level === "diagnostic"
        ? { type: "verbosity", level: args.level }
        : undefined;
    case "animation":
      return args.value === "on" || args.value === "off"
        ? { type: "animation", on: args.value === "on" }
        : undefined;
    case "json":
      return { type: "json" };
    case "clear":
      return { type: "clear" };
    default:
      return undefined;
  }
}
