import { describe, expect, it } from "vitest";

import type { PlannedAction } from "../src/domain.js";
import { isDestructiveAction, isDestructiveActionText } from "../src/planning/action-safety.js";

describe("isDestructiveActionText", () => {
  it.each(["Delete my account", "Proceed to checkout", "Cancel account", "Unsubscribe from updates"])(
    "flags %s as destructive",
    (text) => {
      expect(isDestructiveActionText(text)).toBe(true);
    },
  );

  it("does not flag ordinary navigation or reading text", () => {
    expect(isDestructiveActionText("View the pricing page")).toBe(false);
  });
});

describe("isDestructiveAction", () => {
  it("checks the action's target label and value, not just its description", () => {
    const action: PlannedAction = {
      kind: "interact",
      description: "Click the button",
      target: { page: "/", kind: "button", label: "Delete account" },
    };
    expect(isDestructiveAction(action)).toBe(true);
  });

  it("passes through a benign, fully described action", () => {
    const action: PlannedAction = {
      kind: "interact",
      description: "Fill in the newsletter email field",
      value: "qa@example.test",
      target: { page: "/", kind: "textbox", label: "Email" },
    };
    expect(isDestructiveAction(action)).toBe(false);
  });
});
