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

export type PromptChoice = { label: string; value: string };

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

  async function select(
    label: string,
    choices: PromptChoice[],
    defaultValue?: string,
  ): Promise<string | undefined> {
    if (choices.length === 0) {
      throw new Error(`No choices available for "${label}".`);
    }
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
    io.input.off("data", onData);
    io.input.off("end", onEnd);
    io.input.off("close", onEnd);
  }

  return { line, select, confirm, close };
}
