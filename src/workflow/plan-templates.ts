import type { DiscoverySnapshot, TargetManifest, TestCase, TestPlan } from "../domain/index.js";

const MAX_SMOKE_CASES = 5;
const MAX_FORM_CASES = 3;

/**
 * Deterministic, template-based plan generation — no LLM in this path.
 * Every case is derived directly from what discover actually found:
 * one read-only smoke case per visited page (confirms it still loads and
 * still shows its known title), and one state-changing case per discovered
 * form (fills declared-safe values and checks the submission stayed on the
 * approved domain). This is intentionally conservative: it cannot invent a
 * checkout flow or a login flow it didn't literally see a form for.
 */
export function generatePlanFromDiscovery(
  planId: string,
  manifest: TargetManifest,
  snapshot: DiscoverySnapshot,
  objective: string,
): TestPlan {
  const cases: TestCase[] = [];

  for (const page of snapshot.pages.slice(0, MAX_SMOKE_CASES)) {
    cases.push({
      id: `smoke-${cases.length + 1}`,
      title: `Page loads: ${page.title || page.url}`,
      preconditions: [],
      steps: [{ kind: "navigate", url: page.url, timeoutMs: 15_000 }],
      assertions: [{ kind: "titleContains", expected: page.title || "" }],
      allowedDomains: manifest.allowedDomains,
      executionMode: "read_only",
      riskLevel: "low",
      timeoutMs: 30_000,
      retryPolicy: { maxAttempts: 2, backoffMs: 1_000 },
      recoveryBudget: 2,
    });
  }

  let formCaseCount = 0;
  for (const page of snapshot.pages) {
    if (manifest.runExecutionMode === "observe") {
      break;
    }
    for (const form of page.forms) {
      if (formCaseCount >= MAX_FORM_CASES) {
        break;
      }
      const fillableFields = form.fields.filter(
        (field) => field.name && field.type && !["submit", "button", "hidden"].includes(field.type),
      );
      if (fillableFields.length === 0) {
        continue;
      }

      const fillSteps = fillableFields.map((field) => ({
        kind: "fill" as const,
        selector: `${form.selector} [name="${field.name}"]`,
        value: field.type === "password" ? "secret:standard_user_password" : `test-${field.name}`,
        timeoutMs: 10_000,
      }));

      formCaseCount += 1;
      cases.push({
        id: `form-${formCaseCount}`,
        title: `Submit form on ${page.title || page.url}`,
        preconditions: [`Navigate to ${page.url}`],
        steps: [
          { kind: "navigate", url: page.url, timeoutMs: 15_000 },
          ...fillSteps,
          { kind: "click", selector: `${form.selector} [type="submit"]`, timeoutMs: 10_000 },
        ],
        assertions: [{ kind: "urlContains", expected: new URL(manifest.baseUrl).hostname }],
        allowedDomains: manifest.allowedDomains,
        executionMode: "state_changing",
        riskLevel: "medium",
        timeoutMs: 45_000,
        retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        recoveryBudget: 2,
      });
    }
  }

  if (cases.length === 0) {
    // Discovery found nothing to build a case from — a single guaranteed
    // read-only baseline check keeps the plan valid and still reviewable,
    // the same "never an empty plan" principle as the rest of the product.
    cases.push({
      id: "baseline-1",
      title: `Baseline load: ${manifest.baseUrl}`,
      preconditions: [],
      steps: [{ kind: "navigate", url: manifest.baseUrl, timeoutMs: 15_000 }],
      assertions: [{ kind: "urlContains", expected: new URL(manifest.baseUrl).hostname }],
      allowedDomains: manifest.allowedDomains,
      executionMode: "read_only",
      riskLevel: "low",
      timeoutMs: 30_000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      recoveryBudget: 2,
    });
  }

  return {
    id: planId,
    version: 1,
    objective,
    targetManifestId: manifest.targetId,
    createdAt: new Date().toISOString(),
    cases,
  };
}
