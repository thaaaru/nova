import { Readable, Writable } from "node:stream";

/**
 * A scripted `PromptIO` for deterministic guided-flow tests: `lines` are
 * delivered one per `question()` call (readline's line-mode `terminal:
 * false` reads them exactly like piped input), and every write is
 * captured for assertions instead of touching a real terminal.
 */
export function mockPromptIO(lines: string[], options: { isTTY?: boolean } = {}) {
  const isTTY = options.isTTY ?? true;
  const output: string[] = [];
  const input = new Readable({
    read() {
      // no-op: data is pushed eagerly below
    },
  }) as Readable & { isTTY?: boolean };
  input.isTTY = isTTY;
  for (const line of lines) {
    input.push(`${line}\n`);
  }
  input.push(null);

  const writable = new Writable({
    write(chunk, _encoding, callback) {
      output.push(chunk.toString());
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  writable.isTTY = isTTY;

  return {
    io: { input, output: writable },
    transcript: () => output.join(""),
  };
}
