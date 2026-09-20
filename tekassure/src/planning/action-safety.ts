import type { PlannedAction } from "../domain.js";
import { DANGEROUS_PATH_PARTS } from "../policy.js";

// Extends the navigation-path denylist with verbs that only make sense in
// interaction text (a click/fill description, a button's accessible name)
// rather than a URL path — commerce and account-closure actions in
// particular, which a URL-path check alone would miss.
const DESTRUCTIVE_ACTION_KEYWORDS = [
  ...DANGEROUS_PATH_PARTS,
  "pay",
  "checkout",
  "purchase",
  "buy",
  "charge",
  "refund",
  "transfer",
  "wire",
  "cancel account",
  "close account",
  "deactivate",
  "uninstall",
  "destroy",
];

export function isDestructiveActionText(text: string): boolean {
  const normalized = text.toLowerCase();
  return DESTRUCTIVE_ACTION_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/** Checks every text field on an action a reviewer or LLM could have populated. */
export function isDestructiveAction(action: PlannedAction): boolean {
  const haystack = [action.description, action.value, action.target?.label, action.target?.name]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return isDestructiveActionText(haystack);
}
