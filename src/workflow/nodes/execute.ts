import type { ExecutionResult, TargetManifest, TestCase } from "../../domain/index.js";
import { checkExecutionAllowed, checkCaseScope } from "../../services/policy/scope-policy.js";
import type { SecretResolver } from "../../services/policy/secret-resolver.js";
import type { GraphState } from "../state.js";

export type ExecuteDependencies = {
  executeTestCase: (options: {
    runId: string;
    manifest: TargetManifest;
    testCase: TestCase;
    artifactsDirectory: string;
    headless?: boolean;
    secretResolver: SecretResolver;
  }) => Promise<ExecutionResult>;
  secretResolver: SecretResolver;
  artifactsDirectory: string;
  headless?: boolean;
};

/**
 * Node 4: execute. Runs only the approved plan's cases, each re-checked
 * against policy immediately before it runs (checkExecutionAllowed,
 * checkCaseScope) — this is the code-level backstop the security
 * constraints require: even if something upstream mis-set status, a case
 * that fails either check here is recorded as blocked and skipped, never
 * executed. No arbitrary shell commands anywhere in this path.
 */
export function createExecuteNode(deps: ExecuteDependencies) {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const run = state.run;
    if (!run.testPlan) {
      throw new Error("execute node requires an approved test plan.");
    }

    const results: ExecutionResult[] = [];
    const auditEvents = [...run.auditEvents];

    for (const testCase of run.testPlan.cases) {
      const executionAllowed = checkExecutionAllowed(testCase, run.approval?.decision);
      const scopeAllowed = checkCaseScope(testCase, run.targetManifest);

      if (!executionAllowed.ok || !scopeAllowed.ok) {
        const violation = !executionAllowed.ok
          ? executionAllowed.violation
          : scopeAllowed.ok
            ? undefined
            : scopeAllowed.violation;
        auditEvents.push({
          timestamp: new Date().toISOString(),
          type: "policy_violation_blocked_case",
          detail: { caseId: testCase.id, violation },
          actor: "system",
        });
        results.push({
          caseId: testCase.id,
          attempts: 0,
          stepResults: [],
          assertionResults: [],
          screenshots: [],
          consoleLogs: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          error: `Blocked by policy: ${JSON.stringify(violation)}`,
        });
        continue;
      }

      const result = await deps.executeTestCase({
        runId: run.runId,
        manifest: run.targetManifest,
        testCase,
        artifactsDirectory: deps.artifactsDirectory,
        headless: deps.headless,
        secretResolver: deps.secretResolver,
      });
      results.push(result);
    }

    auditEvents.push({
      timestamp: new Date().toISOString(),
      type: "execution_completed",
      detail: { caseCount: results.length },
      actor: "system",
    });

    return {
      run: {
        ...run,
        executionResults: results,
        status: "executing",
        auditEvents,
      },
    };
  };
}
