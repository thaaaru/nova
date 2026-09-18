import { Readable, Writable } from "node:stream";

/**
 * A scripted `PromptIO` for deterministic guided-flow tests: `lines` are
 * delivered one per `question()` call (readline's line-mode `terminal:
 * false` reads them exactly like piped input), and every write is
 * captured for assertions instead of touching a real terminal.
 *
 * `raw: true` additionally exposes a no-op `setRawMode` so tests can
 * exercise the arrow-key selection path (`isRawModeCapable` requires
 * `setRawMode` to exist) — pass raw byte sequences via `push()` on the
 * returned `io.input` instead of newline-terminated `lines`.
 */
export function mockPromptIO(lines: string[], options: { isTTY?: boolean; raw?: boolean } = {}) {
  const isTTY = options.isTTY ?? true;
  const output: string[] = [];
  const input = new Readable({
    read() {
      // no-op: data is pushed eagerly below
    },
  }) as Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  input.isTTY = isTTY;
  if (options.raw) {
    input.setRawMode = () => undefined;
  }
  for (const line of lines) {
    input.push(`${line}\n`);
  }
  if (!options.raw) {
    input.push(null);
  }

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
