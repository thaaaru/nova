import { createPromptSession, defaultPromptIO, type PromptChoice, type PromptIO } from "./prompt-io.js";
import type { InteractivityDecision, NonInteractiveReason } from "./interactivity.js";

export type FieldParseResult = { ok: true; value: string } | { ok: false; error: string };

export type FieldSpec = {
  /** Key this field's resolved value is stored under. */
  key: string;
  /** The CLI flag an operator would pass instead (used in error/summary text). */
  flag: string;
  /** Prompt/summary label. */
  label: string;
  kind: "text" | "select";
  /** Only used for `kind: "select"`; may depend on already-resolved fields (e.g. journeys within a chosen map). */
  choices?: (resolved: Readonly<Record<string, string>>) => Promise<PromptChoice[]> | PromptChoice[];
  /**
   * A pre-fill shown in a guided prompt, derived from already-resolved
   * fields. Only ever applied *silently* (without a prompt) in
   * non-interactive mode when `nonInteractiveDefault` is also true —
   * a guessed value (e.g. an application name derived from a hostname)
   * must always be confirmed by a human or explicitly passed as a flag.
   */
  defaultValue?: (resolved: Readonly<Record<string, string>>) => string | undefined;
  /** Set only when `defaultValue` is a deterministic fact (e.g. "this journey's environment is its map's environment"), never a guess — allows non-interactive mode to use it without a prompt. */
  nonInteractiveDefault?: boolean;
  /**
   * When true, non-interactive mode leaves this field unresolved (absent
   * from the returned record) instead of failing with a missing-input
   * error when neither `provided` nor a `nonInteractiveDefault` supplied
   * a value. Only for fields whose own downstream consumer has a real
   * fallback of its own (e.g. `discoverMap` identifying the application
   * from crawled content) — never a silent way to skip a value nothing
   * else can supply.
   */
  optionalInNonInteractive?: boolean;
  /** Normalizes and validates a raw candidate value; the sole place a field's rules live. */
  parse: (raw: string, resolved: Readonly<Record<string, string>>) => FieldParseResult;
};

export type ResolveInputsConfig = {
  /** Guided-flow header, e.g. "NOVA — Discover Application". */
  title: string;
  fields: FieldSpec[];
  /** The final Yes/Cancel prompt's label. */
  confirmLabel: string;
  /** A fully-formed example command shown in the non-interactive missing-input error. */
  exampleCommand: string;
};

export class NonInteractiveInputError extends Error {
  readonly missingFlags: string[];

  constructor(missingFlags: string[], exampleCommand: string, reason?: NonInteractiveReason) {
    const hint =
      reason === "ci"
        ? "Guided setup is disabled in CI; pass every value explicitly."
        : reason === "non-tty"
          ? "Guided setup requires an interactive terminal; pass every value explicitly, or run this in a terminal."
          : "Run without --non-interactive to use guided setup.";
    super(`Missing required inputs: ${missingFlags.join(", ")}.\n\n${hint}\n\nExample:\n${exampleCommand}`);
    this.name = "NonInteractiveInputError";
    this.missingFlags = missingFlags;
  }
}

export class CancelledInputError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "CancelledInputError";
  }
}

/**
 * The shared pipeline every guided command runs:
 *
 *   parsed options -> detect interactive capability -> find missing values
 *   -> derive defaults -> prompt only for missing values -> summary +
 *   confirmation -> return resolved, validated string values for the
 *   caller's own Zod schema to parse into its final typed shape.
 *
 * Never itself calls a command service — callers remain the only place
 * `map-service.ts`/`cli/commands.ts` are invoked, so policy/scope/approval
 * enforcement is entirely untouched by this layer.
 */
export async function resolveInputs(
  config: ResolveInputsConfig,
  provided: Readonly<Record<string, string | undefined>>,
  interactivity: InteractivityDecision,
  io: PromptIO = defaultPromptIO,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const field of config.fields) {
    const raw = provided[field.key];
    if (raw !== undefined && raw !== "") {
      const parsed = field.parse(raw, resolved);
      if (parsed.ok) {
        resolved[field.key] = parsed.value;
        continue;
      }
      if (!interactivity.promptingAllowed) {
        missing.push(`${field.flag} (${parsed.error})`);
      }
      continue;
    }
    if (!interactivity.promptingAllowed) {
      const fallback = field.nonInteractiveDefault ? field.defaultValue?.(resolved) : undefined;
      const parsedFallback = fallback !== undefined ? field.parse(fallback, resolved) : undefined;
      if (parsedFallback?.ok) {
        resolved[field.key] = parsedFallback.value;
        continue;
      }
      if (field.optionalInNonInteractive) {
        continue;
      }
      missing.push(field.flag);
    }
  }

  if (!interactivity.promptingAllowed) {
    if (missing.length > 0) {
      throw new NonInteractiveInputError(missing, config.exampleCommand, interactivity.reason);
    }
    return resolved;
  }

  const everythingResolved = config.fields.every((field) => resolved[field.key] !== undefined);
  if (everythingResolved && !interactivity.forceReview) {
    return resolved;
  }

  const session = createPromptSession(io);
  try {
    io.output.write(`${config.title}\n\n`);
    for (const field of config.fields) {
      const alreadyResolved = resolved[field.key];
      if (alreadyResolved !== undefined && !interactivity.forceReview) {
        continue;
      }
      const defaultCandidate = alreadyResolved ?? field.defaultValue?.(resolved);

      if (field.kind === "select") {
        const choices = await field.choices?.(resolved);
        if (!choices || choices.length === 0) {
          throw new Error(`No choices available for "${field.label}".`);
        }
        const chosen = await session.select(field.label, choices, defaultCandidate);
        if (chosen === undefined) {
          throw new CancelledInputError();
        }
        const parsed = field.parse(chosen, resolved);
        if (!parsed.ok) {
          throw new Error(parsed.error);
        }
        resolved[field.key] = parsed.value;
        continue;
      }

      for (;;) {
        const answer = await session.line(field.label, defaultCandidate);
        if (answer === undefined) {
          throw new CancelledInputError();
        }
        if (answer === "") {
          io.output.write("This field is required.\n");
          continue;
        }
        const parsed = field.parse(answer, resolved);
        if (parsed.ok) {
          resolved[field.key] = parsed.value;
          break;
        }
        io.output.write(`${parsed.error}\n`);
      }
    }

    io.output.write("\nSummary:\n");
    for (const field of config.fields) {
      io.output.write(`  ${field.label}: ${resolved[field.key]}\n`);
    }
    io.output.write("\n");
    const confirmed = await session.confirm(config.confirmLabel);
    if (!confirmed) {
      throw new CancelledInputError();
    }
    return resolved;
  } finally {
    session.close();
  }
}
