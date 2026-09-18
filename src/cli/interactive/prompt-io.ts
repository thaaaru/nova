/**
 * The two streams a guided prompt reads from/writes to. Defaults to the
 * real process streams; every prompt function accepts an override so
 * tests can drive input deterministically without touching a real TTY.
 */
export type PromptIO = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
};

export const defaultPromptIO: PromptIO = { input: process.stdin, output: process.stdout };

/** True only when both ends are a real interactive terminal. */
export function isInteractiveTTY(io: PromptIO = defaultPromptIO): boolean {
  return Boolean((io.input as NodeJS.ReadStream).isTTY) && Boolean((io.output as NodeJS.WriteStream).isTTY);
}

/**
 * True when the input stream can be switched into raw (non-canonical)
 * mode, which is what lets arrow keys reach the process at all — in
 * cooked mode the terminal driver consumes them for its own line
 * editing and a Node process never sees the bytes.
 */
function isRawModeCapable(io: PromptIO): boolean {
  const input = io.input as NodeJS.ReadStream;
  return typeof input.setRawMode === "function" && isInteractiveTTY(io);
}

export type PromptChoice = { label: string; value: string };

type RawKey = "up" | "down" | "enter" | "cancel";

/**
 * Pure escape-sequence scanner: consumes as many complete keys as
 * `chunk` contains and returns whatever trailing bytes are not yet
 * resolvable (e.g. a lone ESC that might be the start of an arrow
 * sequence delivered in the next chunk).
 */
export function parseRawKeys(chunk: string): { keys: RawKey[]; rest: string } {
  const keys: RawKey[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];
    if (ch === "\r" || ch === "\n") {
      keys.push("enter");
      i += 1;
      continue;
    }
    if (ch === "\u0003") {
      keys.push("cancel");
      i += 1;
      continue;
    }
    if (ch === "\u001b") {
      if (i + 2 >= chunk.length) {
        break;
      }
      const sequence = chunk.slice(i, i + 3);
      if (sequence === "\u001b[A") {
        keys.push("up");
        i += 3;
        continue;
      }
      if (sequence === "\u001b[B") {
        keys.push("down");
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return { keys, rest: chunk.slice(i) };
}

/** Wraps a highlighted-choice index by one step; pure so it is trivially testable. */
export function moveSelection(index: number, direction: "up" | "down", length: number): number {
  if (length <= 0) {
    return 0;
  }
  return direction === "up" ? (index - 1 + length) % length : (index + 1) % length;
}

/**
 * One line-buffered reader shared across every question in a single
 * guided flow. A real interactive terminal is normally in cooked mode,
 * so the OS itself already handles backspace/line editing before Node
 * ever sees a byte — a hand-rolled newline splitter is all a
 * question-and-answer flow needs, and (unlike re-wrapping `node:readline`
 * per question) it never silently drops input queued ahead of the
 * question that is about to ask for it.
 */
export type PromptSession = {
  line(label: string, defaultValue?: string): Promise<string | undefined>;
  select(label: string, choices: PromptChoice[], defaultValue?: string): Promise<string | undefined>;
  confirm(label: string): Promise<boolean>;
  close(): void;
};

export function createPromptSession(io: PromptIO = defaultPromptIO): PromptSession {
  let buffer = "";
  let ended = false;
  const waiters: Array<(line: string | undefined) => void> = [];

  function flushCompleteLines(): void {
    let newlineIndex: number;
    while (waiters.length > 0 && (newlineIndex = buffer.indexOf("\n")) >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      waiters.shift()!(rawLine);
    }
    if (ended) {
      while (waiters.length > 0) {
        waiters.shift()!(undefined);
      }
    }
  }

  function onData(chunk: Buffer | string): void {
    buffer += chunk.toString();
    flushCompleteLines();
  }
  function onEnd(): void {
    ended = true;
    flushCompleteLines();
  }
  io.input.on("data", onData);
  io.input.on("end", onEnd);
  io.input.on("close", onEnd);

  function nextLine(): Promise<string | undefined> {
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    waiters.push(resolve);
    flushCompleteLines();
    return promise;
  }

  async function line(label: string, defaultValue?: string): Promise<string | undefined> {
    const hint = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
    io.output.write(`${label}${hint}\n\u203a `);
    const answer = await nextLine();
    if (answer === undefined) {
      return undefined;
    }
    const trimmed = answer.trim();
    return trimmed === "" ? defaultValue : trimmed;
  }

  let activeRawCleanup: (() => void) | undefined;

  async function select(
    label: string,
    choices: PromptChoice[],
    defaultValue?: string,
  ): Promise<string | undefined> {
    if (choices.length === 0) {
      throw new Error(`No choices available for "${label}".`);
    }
    return isRawModeCapable(io)
      ? selectArrowKeys(label, choices, defaultValue)
      : selectNumeric(label, choices, defaultValue);
  }

  async function selectNumeric(
    label: string,
    choices: PromptChoice[],
    defaultValue?: string,
  ): Promise<string | undefined> {
    io.output.write(`${label}:\n`);
    for (const [index, choice] of choices.entries()) {
      const marker = choice.value === defaultValue ? "\u203a" : " ";
      io.output.write(`${marker} ${index + 1}) ${choice.label}\n`);
    }
    const prompt = defaultValue !== undefined ? "Enter a number (Enter for default): " : "Enter a number: ";
    for (;;) {
      io.output.write(prompt);
      const answer = await nextLine();
      if (answer === undefined) {
        return undefined;
      }
      const trimmed = answer.trim();
      if (trimmed === "" && defaultValue !== undefined) {
        return defaultValue;
      }
      const index = Number.parseInt(trimmed, 10);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
        return choices[index - 1]?.value;
      }
      const byLabel = choices.find((choice) => choice.label.toLowerCase() === trimmed.toLowerCase());
      if (byLabel) {
        return byLabel.value;
      }
      io.output.write(`Enter a number between 1 and ${choices.length}.\n`);
    }
  }

  /**
   * Real arrow-key navigation for an actual terminal: switches the shared
   * input stream into raw mode for the duration of this one question only
   * (the line-buffered `onData` listener is detached and reattached around
   * it), redraws the choice list in place as the highlight moves, and
   * restores cooked/line mode before returning so every other prompt keeps
   * behaving exactly as before.
   */
  function selectArrowKeys(
    label: string,
    choices: PromptChoice[],
    defaultValue?: string,
  ): Promise<string | undefined> {
    const input = io.input as NodeJS.ReadStream;
    const hintLine = "(Use up/down, Enter to select, Ctrl+C to cancel)";
    let index = Math.max(
      0,
      choices.findIndex((choice) => choice.value === defaultValue),
    );

    const renderChoice = (choice: PromptChoice, selected: boolean): string =>
      `${selected ? "\u203a" : " "} ${choice.label}\n`;

    io.output.write(`${label}:\n`);
    for (const [choiceIndex, choice] of choices.entries()) {
      io.output.write(renderChoice(choice, choiceIndex === index));
    }
    io.output.write(`${hintLine}\n`);

    io.input.off("data", onData);
    input.setRawMode(true);
    input.resume();

    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    let pending = "";

    function redraw(): void {
      io.output.write(`\u001b[${choices.length + 1}A`);
      for (const [choiceIndex, choice] of choices.entries()) {
        io.output.write(`\u001b[2K${renderChoice(choice, choiceIndex === index)}`);
      }
      io.output.write(`\u001b[2K${hintLine}\n`);
    }

    function cleanup(): void {
      input.off("data", onRawData);
      input.setRawMode(false);
      io.input.on("data", onData);
      activeRawCleanup = undefined;
    }

    function onRawData(chunk: Buffer | string): void {
      pending += chunk.toString();
      const { keys, rest } = parseRawKeys(pending);
      pending = rest;
      for (const key of keys) {
        if (key === "cancel") {
          cleanup();
          io.output.write("\n");
          resolve(undefined);
          return;
        }
        if (key === "enter") {
          cleanup();
          io.output.write("\n");
          resolve(choices[index]?.value);
          return;
        }
        index = moveSelection(index, key, choices.length);
        redraw();
      }
    }

    activeRawCleanup = cleanup;
    input.on("data", onRawData);
    return promise;
  }

  async function confirm(label: string): Promise<boolean> {
    const choice = await select(
      label,
      [
        { label: "Yes", value: "yes" },
        { label: "Cancel", value: "cancel" },
      ],
      "yes",
    );
    return choice === "yes";
  }

  function close(): void {
    activeRawCleanup?.();
    io.input.off("data", onData);
    io.input.off("end", onEnd);
    io.input.off("close", onEnd);
  }

  return { line, select, confirm, close };
}
