import type { RunEvent, RunViewModel, TestCounts, TestRunState, VerbosityLevel } from "../../domain/index.js";
import type { TimelineStageId } from "../../domain/index.js";
import { filterEventsByVerbosity } from "./verbosity.js";

/**
 * The single place a persisted TestRunState (or its absence, for the
 * first-run onboarding case) is translated into what the Home and Live
 * Execution screens render. Every screen consumes RunViewModel only —
 * never TestRunState fields directly — so redaction/verbosity rules and
 * "what counts as done" stay defined in one testable function.
 */

const STAGE_BY_STATUS: Record<TestRunState["status"], TimelineStageId> = {
  discovering: "discover",
  planning: "plan",
  awaiting_approval: "approval",
  approved: "approval",
  rejected: "approval",
  executing: "execute",
  verifying: "verify",
  completed: "report",
  failed: "verify",
  blocked: "execute",
};

export const POLICY_MODE_LABEL: Record<string, string> = {
  observe: "Observe (read-only)",
  safe_test: "Safe test (state-changing allowed, approval required)",
  destructive_test: "Destructive test (high-risk cases allowed, approval required)",
};

function emptyTestCounts(): TestCounts {
  return { planned: 0, passed: 0, failed: 0, flaky: 0, blocked: 0, inconclusive: 0, pending: 0 };
}

function countTestOutcomes(state: TestRunState): TestCounts {
  const planned = state.testPlan?.cases.length ?? 0;
  const counts = emptyTestCounts();
  counts.planned = planned;
  for (const verification of state.verificationResults) {
    switch (verification.classification) {
      case "passed":
        counts.passed += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "flaky":
        counts.flaky += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "inconclusive":
        counts.inconclusive += 1;
        break;
    }
  }
  counts.pending = Math.max(0, planned - state.verificationResults.length);
  return counts;
}

function buildBlockers(state: TestRunState): string[] {
  const blockers: string[] = [];
  if (!state.discoverySnapshot) {
    blockers.push("No discovery yet — run discover before planning.");
  }
  if (state.discoverySnapshot && !state.testPlan) {
    blockers.push("No plan yet — discover first, then plan.");
  }
  if (state.testPlan && !state.approval) {
    blockers.push("Awaiting approval — the plan cannot execute until reviewed.");
  }
  if (state.approval?.decision === "rejected") {
    blockers.push(`Plan rejected${state.approval.note ? `: ${state.approval.note}` : "."}`);
  }
  if (state.status === "blocked") {
    blockers.push("Run is blocked — check the event feed for the policy or execution reason.");
  }
  if (state.status === "failed") {
    blockers.push("Run failed — see verification results for confirmed defects.");
  }
  return blockers;
}

function buildNextActions(state: TestRunState): RunViewModel["nextActions"] {
  if (!state.discoverySnapshot) {
    return [
      {
        id: "discover",
        label: "Discover target",
        command: `:discover --target ${state.targetManifest.baseUrl}`,
        description: "Crawl the approved target and capture a read-only application map.",
      },
    ];
  }
  if (!state.testPlan) {
    return [
      {
        id: "plan",
        label: "Generate test plan",
        command: `:plan --objective "<what this run should test>"`,
        description: "Produce a reviewable TestPlan from the discovered application map.",
      },
    ];
  }
  if (!state.approval) {
    return [
      {
        id: "approve",
        label: "Review and approve plan",
        command: `:approve --plan ${state.testPlan.id}`,
        description: "No execution can happen before this plan is approved.",
      },
    ];
  }
  if (state.approval.decision === "rejected") {
    return [
      {
        id: "replan",
        label: "Return to planning",
        command: `:plan --objective "<revised objective>"`,
        description: "The previous plan was rejected; generate a new one.",
      },
    ];
  }
  if (state.status === "approved") {
    return [
      {
        id: "run",
        label: "Execute approved plan",
        command: `:run --plan ${state.testPlan.id}`,
        description: "Run every approved test case, then verify and report.",
      },
    ];
  }
  if (state.status === "completed" || state.status === "failed" || state.status === "blocked") {
    return [
      {
        id: "report",
        label: "Open report",
        command: `:report --run ${state.runId}`,
        description: "Generate JSON, JUnit, and HTML reports for this run.",
      },
    ];
  }
  return [];
}

function summarizeScope(state: TestRunState): string {
  const { targetManifest } = state;
  return `${targetManifest.baseUrl} (${targetManifest.allowedDomains.join(", ")})`;
}

function pickLastEvent(events: RunEvent[]): RunEvent | undefined {
  return events.length > 0 ? events[events.length - 1] : undefined;
}

/**
 * Builds the Home/Live-Execution view model. `state` is `undefined` before
 * any run exists locally (fresh data directory) — callers render the
 * onboarding "run guided setup" state in that case. `events` is the live
 * event feed already accumulated for this run (see services/events.ts);
 * it is passed in rather than derived here because event sequencing is a
 * runtime concern, not something recoverable from a single persisted
 * TestRunState snapshot alone.
 */
export function buildRunViewModel(
  state: TestRunState | undefined,
  verbosity: VerbosityLevel,
  events: RunEvent[] = [],
): RunViewModel {
  if (!state) {
    return {
      policyModeLabel: "No target configured yet",
      testCounts: emptyTestCounts(),
      blockers: ["No run yet — start guided setup to configure a target."],
      nextActions: [
        {
          id: "guided-setup",
          label: "Run guided setup",
          command: ":discover --target <url>",
          description: "Configure a target and run the first discovery.",
        },
      ],
      recovery: { active: false },
    };
  }

  const recoveryAttempt = state.executionResults
    .flatMap((execution) => execution.recoveryAttempts.map((attempt) => ({ execution, attempt })))
    .find(({ attempt }) => attempt.outcome !== "recovered" || state.status === "executing");

  return {
    runId: state.runId,
    projectId: state.projectId,
    tenantId: state.tenantId,
    environment: state.targetManifest.environment,
    targetBaseUrl: state.targetManifest.baseUrl,
    runExecutionMode: state.targetManifest.runExecutionMode,
    status: state.status,
    currentStage: STAGE_BY_STATUS[state.status],
    scopeSummary: summarizeScope(state),
    policyModeLabel:
      POLICY_MODE_LABEL[state.targetManifest.runExecutionMode] ?? state.targetManifest.runExecutionMode,
    testCounts: countTestOutcomes(state),
    lastEvent: pickLastEvent(filterEventsByVerbosity(events, verbosity)),
    blockers: buildBlockers(state),
    nextActions: buildNextActions(state),
    recovery: recoveryAttempt
      ? {
          active: true,
          caseId: recoveryAttempt.execution.caseId,
          checkpoint: recoveryAttempt.attempt.checkpoint,
          failureSummary: recoveryAttempt.attempt.failureSummary,
          evidenceSummary: recoveryAttempt.attempt.evidenceSummary,
          action: recoveryAttempt.attempt.action,
          attempt: recoveryAttempt.attempt.attempt,
          maxAttempts: recoveryAttempt.attempt.maxAttempts,
        }
      : { active: false },
  };
}
