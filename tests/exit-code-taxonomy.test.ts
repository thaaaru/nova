import { describe, expect, it } from "vitest";

import { classifyExitCode } from "../src/cli/exit-code.js";
import { CancelledInputError, NonInteractiveInputError } from "../src/cli/interactive/resolve-inputs.js";
import { FixtureLockedError, JourneyScopeError } from "../src/services/testmap/journey-run-service.js";

describe("classifyExitCode", () => {
  it("maps a user cancellation (Ctrl+C during a guided prompt) to 130, the SIGINT convention", () => {
    expect(classifyExitCode(new CancelledInputError())).toBe(130);
  });

  it("maps a non-interactive missing-input failure to 1", () => {
    expect(classifyExitCode(new NonInteractiveInputError(["--target"], "nova discover --target <url>"))).toBe(
      1,
    );
  });

  it("maps a JourneyScopeError (policy/approval/scope block) to 2", () => {
    expect(classifyExitCode(new JourneyScopeError("out of scope"))).toBe(2);
  });

  it("maps a FixtureLockedError (policy/approval/scope block) to 2", () => {
    expect(classifyExitCode(new FixtureLockedError("fixture locked"))).toBe(2);
  });

  it("maps a generic Error to 1", () => {
    expect(classifyExitCode(new Error("something broke"))).toBe(1);
  });

  it("maps a non-Error thrown value to 1", () => {
    expect(classifyExitCode("a string throw")).toBe(1);
  });
});
