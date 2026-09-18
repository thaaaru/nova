import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import type { RecoveryAttempt } from "../../src/domain/index.js";
import { RecoveryCard } from "../../src/tui/components/RecoveryCard.js";

// A real attempt whose `checkpoint` fell back to a raw CSS selector
// (describeCheckpoint in recovery-agent.ts falls back to step.selector
// when the step has no declared name) and whose `action` names an
// internal locator strategy — exactly the shape standard verbosity must
// never leak.
const attempt: RecoveryAttempt = {
  stepIndex: 2,
  checkpoint: "#pay-now-button",
  failureSummary: "The expected payment control is no longer available.",
  evidenceSummary: "No element matched via declared selector.",
  action: "Tried declared selector.",
  attempt: 1,
  maxAttempts: 2,
  outcome: "exhausted",
};

describe("RecoveryCard", () => {
  it("renders the exact QA-language sections at standard verbosity", () => {
    const { lastFrame } = render(<RecoveryCard caseId="case-1" attempt={attempt} verbosity="standard" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Observed:");
    expect(frame).toContain("The expected payment control is no longer available.");
    expect(frame).toContain("Nova proposes:");
    expect(frame).toContain("Recovery:");
    expect(frame).toContain("Attempt 1 of 2");
  });

  it("never renders a raw locator-strategy string or selector value at standard verbosity", () => {
    const { lastFrame } = render(<RecoveryCard caseId="case-1" attempt={attempt} verbosity="standard" />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("#pay-now-button");
    expect(frame).not.toContain("declared selector");
  });

  it("reveals the raw strategy/locator detail at diagnostic verbosity", () => {
    const { lastFrame } = render(<RecoveryCard caseId="case-1" attempt={attempt} verbosity="diagnostic" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("#pay-now-button");
    expect(frame).toContain("declared selector");
  });
});
