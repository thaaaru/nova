import type { CommandParseResult } from "../../domain/index.js";
import { COMMAND_SPECS } from "./command-specs.js";

/**
 * Splits a command line into tokens, treating `"..."` as one token so
 * `:plan --objective "check the checkout flow"` yields a single objective
 * token rather than being split on spaces.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? "");
  }
  return tokens;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses one `:`-mode command line into a `CommandParseResult`. Never
 * throws — every failure (unknown command, missing required flag,
 * malformed URL, invalid enum value) is returned as an `{ ok: false }`
 * result for the command bar to render, per domain/schemas/tui.ts's
 * `CommandParseResultSchema`.
 */
export function parseCommand(input: string): CommandParseResult {
  const trimmed = input.trim().replace(/^:/, "");
  if (trimmed.length === 0) {
    return { ok: false, error: "Empty command. Type :help for the command list." };
  }

  const tokens = tokenize(trimmed);
  const name = tokens[0]?.toLowerCase() ?? "";
  const spec = COMMAND_SPECS.find((candidate) => candidate.name === name);
  if (!spec) {
    return { ok: false, error: `Unknown command ":${name}". Type :help for the command list.` };
  }

  const args: Record<string, string> = {};
  const rest = tokens.slice(1);
  let positionalIndex = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token?.startsWith("--")) {
      const flagName = token.slice(2);
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: `Flag --${flagName} needs a value.` };
      }
      args[flagName] = value;
      i += 1;
    } else if (token !== undefined && positionalIndex < spec.positional.length) {
      args[spec.positional[positionalIndex] ?? ""] = token;
      positionalIndex += 1;
    }
  }

  for (const requiredFlag of spec.requiredFlags) {
    if (!args[requiredFlag]) {
      return { ok: false, error: `":${name}" requires --${requiredFlag} <value>.` };
    }
  }
  for (const positionalName of spec.positional) {
    if (!args[positionalName]) {
      return { ok: false, error: `":${name}" requires a "${positionalName}" argument.` };
    }
  }
  if (spec.allowedValues) {
    for (const [key, allowed] of Object.entries(spec.allowedValues)) {
      const value = args[key];
      if (value !== undefined && !allowed.includes(value)) {
        return { ok: false, error: `":${name} ${key}" must be one of: ${allowed.join(", ")}.` };
      }
    }
  }
  if (name === "discover" && args.target !== undefined && !isValidUrl(args.target)) {
    return { ok: false, error: `--target "${args.target}" is not a valid URL.` };
  }

  return { ok: true, name, args };
}
