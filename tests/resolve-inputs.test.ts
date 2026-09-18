import { describe, expect, it } from "vitest";

import { detectInteractivity } from "../src/cli/interactive/interactivity.js";
import {
  CancelledInputError,
  NonInteractiveInputError,
  resolveInputs,
} from "../src/cli/interactive/resolve-inputs.js";
import { mapDiscoverResolveConfig } from "../src/cli/interactive/commands/map-discover.js";
import { mockPromptIO } from "./support/mock-prompt-io.js";

const NON_INTERACTIVE = { promptingAllowed: false, forceReview: false } as const;

describe("resolveInputs — nova map discover", () => {
  it("runs directly with zero prompts when every input is already supplied", async () => {
    const { io, transcript } = mockPromptIO([]);
    const resolved = await resolveInputs(
      mapDiscoverResolveConfig,
      { target: "https://teklab.dev", name: "TekLab", env: "staging" },
      { promptingAllowed: true, forceReview: false },
      io,
    );
    expect(resolved).toEqual({ target: "https://teklab.dev", name: "TekLab", env: "staging" });
    expect(transcript()).toBe("");
  });

  it("prompts only for the missing values, pre-filling derived defaults", async () => {
    // target is supplied; name and env are missing and must be derived/prompted for.
    const { io, transcript } = mockPromptIO([
      "", // application name -> accept the derived default "Teklab"
      "1", // environment select -> explicitly choose option 1 ("Local"), overriding the derived "staging" default
      "1", // confirm -> "Yes"
    ]);
    const resolved = await resolveInputs(
      mapDiscoverResolveConfig,
      { target: "https://teklab.dev", name: undefined, env: undefined },
      { promptingAllowed: true, forceReview: false },
      io,
    );
    expect(resolved.target).toBe("https://teklab.dev");
    expect(resolved.name).toBe("Teklab");
    expect(resolved.env).toBe("local");
    const output = transcript();
    expect(output).toContain("NOVA \u2014 Discover Application");
    expect(output).toContain("Target URL");
    expect(output).not.toMatch(/Target URL.*\n.*Target URL/s);
    expect(output).toContain("Application name");
    expect(output).toContain("Environment");
    expect(output).toContain("Summary:");
    expect(output).toContain("Start discovery?");
  });

  it("re-prompts on an invalid URL before accepting a corrected one", async () => {
    const { io, transcript } = mockPromptIO([
      "not a url", // invalid -> re-prompt
      "https://teklab.dev", // valid
      "", // name -> accept derived default
      "", // env -> accept derived default (staging)
      "yes",
    ]);
    const resolved = await resolveInputs(
      mapDiscoverResolveConfig,
      {},
      { promptingAllowed: true, forceReview: false },
      io,
    );
    expect(resolved.target).toBe("https://teklab.dev");
    expect(transcript()).toMatch(/Enter a valid absolute URL/);
  });

  it("rejects Markdown link syntax and re-prompts", async () => {
    const { io, transcript } = mockPromptIO([
      "[https://teklab.dev](https://teklab.dev)",
      "https://teklab.dev",
      "",
      "",
      "yes",
    ]);
    const resolved = await resolveInputs(
      mapDiscoverResolveConfig,
      {},
      { promptingAllowed: true, forceReview: false },
      io,
    );
    expect(resolved.target).toBe("https://teklab.dev");
    expect(transcript()).toMatch(/Markdown/);
  });

  it("cancels cleanly when the operator selects Cancel at the final confirmation", async () => {
    const { io } = mockPromptIO([
      "https://teklab.dev",
      "",
      "",
      "2", // Cancel
    ]);
    await expect(
      resolveInputs(mapDiscoverResolveConfig, {}, { promptingAllowed: true, forceReview: false }, io),
    ).rejects.toThrow(CancelledInputError);
  });

  it("cancels cleanly when input ends before an answer arrives (Ctrl+C/EOF)", async () => {
    const { io } = mockPromptIO([]); // stream closes immediately, no answer for the first prompt
    await expect(
      resolveInputs(mapDiscoverResolveConfig, {}, { promptingAllowed: true, forceReview: false }, io),
    ).rejects.toThrow(CancelledInputError);
  });

  it("--interactive re-reviews every field even when all inputs are already valid", async () => {
    const { io, transcript } = mockPromptIO([
      "", // keep the pre-filled target
      "", // keep the pre-filled name
      "", // keep the pre-filled environment
      "yes",
    ]);
    const resolved = await resolveInputs(
      mapDiscoverResolveConfig,
      { target: "https://teklab.dev", name: "TekLab", env: "staging" },
      { promptingAllowed: true, forceReview: true },
      io,
    );
    expect(resolved).toEqual({ target: "https://teklab.dev", name: "TekLab", env: "staging" });
    expect(transcript()).toContain("Summary:");
  });

  it("non-interactive mode never prompts and reports every missing input in one error", async () => {
    await expect(resolveInputs(mapDiscoverResolveConfig, {}, NON_INTERACTIVE)).rejects.toThrow(
      NonInteractiveInputError,
    );
    try {
      await resolveInputs(mapDiscoverResolveConfig, {}, NON_INTERACTIVE);
      throw new Error("expected resolveInputs to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NonInteractiveInputError);
      const message = (error as Error).message;
      expect(message).toContain("Missing required inputs: --target, --name, --env.");
      expect(message).toContain("nova map discover --target https://teklab.dev --name TekLab --env staging");
    }
  });

  it("non-interactive mode runs directly when every input is already supplied and valid", async () => {
    const resolved = await resolveInputs(
      mapDiscoverResolveConfig,
      { target: "https://teklab.dev", name: "TekLab", env: "staging" },
      NON_INTERACTIVE,
    );
    expect(resolved).toEqual({ target: "https://teklab.dev", name: "TekLab", env: "staging" });
  });

  it("non-interactive mode never guesses a derived default (e.g. environment) — it must be explicit", async () => {
    await expect(
      resolveInputs(
        mapDiscoverResolveConfig,
        { target: "https://teklab.dev", name: "TekLab" },
        NON_INTERACTIVE,
      ),
    ).rejects.toThrow(/--env/);
  });

  it("CI/non-TTY execution never prompts (detectInteractivity feeds resolveInputs)", async () => {
    const { io } = mockPromptIO([], { isTTY: false });
    const interactivity = detectInteractivity({}, io);
    expect(interactivity.promptingAllowed).toBe(false);
    await expect(
      resolveInputs(mapDiscoverResolveConfig, { target: "https://teklab.dev" }, interactivity, io),
    ).rejects.toThrow(NonInteractiveInputError);
  });
});
