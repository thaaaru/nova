import { afterEach, describe, expect, it } from "vitest";

import { detectInteractivity } from "../src/cli/interactive/interactivity.js";
import { mockPromptIO } from "./support/mock-prompt-io.js";

describe("detectInteractivity", () => {
  const originalCI = process.env.CI;

  afterEach(() => {
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
  });

  it("prompts when the stream is a real TTY and no flags are given", () => {
    delete process.env.CI;
    const { io } = mockPromptIO([], { isTTY: true });
    expect(detectInteractivity({}, io)).toEqual({ promptingAllowed: true, forceReview: false });
  });

  it("forces a full guided review with --interactive on a TTY", () => {
    delete process.env.CI;
    const { io } = mockPromptIO([], { isTTY: true });
    expect(detectInteractivity({ interactive: true }, io)).toEqual({
      promptingAllowed: true,
      forceReview: true,
    });
  });

  it("never prompts with --non-interactive, even on a TTY", () => {
    delete process.env.CI;
    const { io } = mockPromptIO([], { isTTY: true });
    const decision = detectInteractivity({ nonInteractive: true }, io);
    expect(decision.promptingAllowed).toBe(false);
    expect(decision.reason).toBe("flag");
  });

  it("never prompts in CI, even with --interactive on a TTY", () => {
    process.env.CI = "true";
    const { io } = mockPromptIO([], { isTTY: true });
    const decision = detectInteractivity({ interactive: true }, io);
    expect(decision.promptingAllowed).toBe(false);
    expect(decision.reason).toBe("ci");
  });

  it("never prompts on a non-TTY stream, even with --interactive", () => {
    delete process.env.CI;
    const { io } = mockPromptIO([], { isTTY: false });
    const decision = detectInteractivity({ interactive: true }, io);
    expect(decision.promptingAllowed).toBe(false);
    expect(decision.reason).toBe("non-tty");
  });

  it("--non-interactive takes precedence over --interactive", () => {
    delete process.env.CI;
    const { io } = mockPromptIO([], { isTTY: true });
    const decision = detectInteractivity({ interactive: true, nonInteractive: true }, io);
    expect(decision.promptingAllowed).toBe(false);
    expect(decision.reason).toBe("flag");
  });
});
