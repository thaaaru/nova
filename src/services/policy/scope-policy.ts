import type { TargetManifest } from "../../domain/index.js";
import type { TestCase } from "../../domain/index.js";

export type PolicyViolation =
  | { kind: "unknown_domain"; domain: string }
  | { kind: "unsafe_execution_mode"; caseId: string; mode: string }
  | { kind: "unapproved_plan" }
  | { kind: "domain_not_in_manifest"; caseId: string; domain: string }
  | { kind: "state_changing_forbidden_in_observe_mode"; caseId: string };

export type PolicyCheckResult = { ok: true } | { ok: false; violation: PolicyViolation };

/**
 * The single authoritative scope check. Nothing about this is inferred
 * from model output — it is a plain string comparison against the
 * manifest's allowedDomains, enforced in code outside model context, per
 * the product's core boundary: the LLM may propose, it may never decide
 * authorization.
 */
export function isDomainAllowed(url: string, manifest: TargetManifest): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return manifest.allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

/**
 * Every domain a case declares (allowedDomains) must itself be a subset
 * of the manifest's allowedDomains — a case cannot widen its own scope
 * beyond what the manifest grants, regardless of who or what authored it.
 */
export function checkCaseScope(testCase: TestCase, manifest: TargetManifest): PolicyCheckResult {
  for (const domain of testCase.allowedDomains) {
    const withinManifest = manifest.allowedDomains.some(
      (allowed) => domain === allowed || domain.endsWith(`.${allowed}`) || allowed.endsWith(`.${domain}`),
    );
    if (!withinManifest) {
      return { ok: false, violation: { kind: "domain_not_in_manifest", caseId: testCase.id, domain } };
    }
  }
  return { ok: true };
}

/**
 * Checks a runtime navigation/request URL against the manifest during
 * execution — the same rule as checkCaseScope, applied live rather than
 * at plan-review time, since a redirect or a link click can reach a URL
 * the plan never explicitly declared.
 */
export function checkRuntimeUrl(url: string, manifest: TargetManifest): PolicyCheckResult {
  if (!isDomainAllowed(url, manifest)) {
    return { ok: false, violation: { kind: "unknown_domain", domain: safeHostname(url) } };
  }
  return { ok: true };
}

/**
 * State-changing execution mode requires the plan to already carry an
 * "approved" decision — this is the code-level backstop for the approval
 * gate, checked again immediately before execute() runs regardless of
 * what the workflow status field claims, so a bug elsewhere in the graph
 * can never let an unapproved state-changing case run.
 */
export function checkExecutionAllowed(
  testCase: TestCase,
  approvalDecision: "approved" | "rejected" | undefined,
  manifest: TargetManifest,
): PolicyCheckResult {
  if (manifest.runExecutionMode === "observe" && testCase.executionMode === "state_changing") {
    return {
      ok: false,
      violation: { kind: "state_changing_forbidden_in_observe_mode", caseId: testCase.id },
    };
  }
  if (testCase.executionMode === "state_changing" && approvalDecision !== "approved") {
    return {
      ok: false,
      violation: { kind: "unsafe_execution_mode", caseId: testCase.id, mode: testCase.executionMode },
    };
  }
  if (approvalDecision !== "approved") {
    return { ok: false, violation: { kind: "unapproved_plan" } };
  }
  return { ok: true };
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
