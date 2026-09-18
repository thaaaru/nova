import type {
  AuditEvent,
  DefectClassification,
  ExecutionResult,
  Finding,
  ReportData,
  ReportEvidenceLink,
  RiskLevel,
  TestPlan,
  TestRunState,
  TimelineStage,
  TimelineStageId,
  VerificationClassification,
  VerificationResult,
} from "../../domain/index.js";

export const NOVA_VERSION = "0.1.0";
export const REPORT_SCHEMA_VERSION = 1;

const STAGE_COMPLETION_EVENT: Record<TimelineStageId, string[]> = {
  discover: ["discovery_completed"],
  plan: ["plan_ready_for_approval"],
  approval: ["plan_approved", "plan_rejected"],
  execute: ["execution_completed"],
  verify: ["verification_completed"],
  report: ["report_generated"],
};
const STAGE_ORDER: TimelineStageId[] = ["discover", "plan", "approval", "execute", "verify", "report"];

/**
 * The single place TestRunState is translated into what the HTML report
 * (and, for the summary parts, the TUI) actually renders. Every redaction
 * decision lives here: secrets never entered TestRunState in the first
 * place (see services/policy/secret-resolver.ts), but this is still where
 * raw-result fields get pared down to what an auditor should see.
 */
export function buildReportData(state: TestRunState): ReportData {
  const caseTitles = new Map(state.testPlan?.cases.map((testCase) => [testCase.id, testCase.title]) ?? []);
  const verificationByCase = new Map(state.verificationResults.map((result) => [result.caseId, result]));
  const executionByCase = new Map(state.executionResults.map((result) => [result.caseId, result]));

  const timeline = buildTimeline(state.auditEvents);
  const startedAt = state.auditEvents.at(0)?.timestamp;
  const completedAt = state.auditEvents.at(-1)?.timestamp;

  return {
    header: {
      runId: state.runId,
      projectId: state.projectId,
      tenantId: state.tenantId,
      environment: state.targetManifest.environment,
      targetBaseUrl: state.targetManifest.baseUrl,
      executionMode: state.targetManifest.runExecutionMode,
      startedAt,
      completedAt,
      totalDurationMs:
        startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : undefined,
      terminalOutcome: state.status,
      novaVersion: NOVA_VERSION,
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
    },
    executiveSummary: buildExecutiveSummary(state),
    timeline,
    charts: {
      distribution: countByClassification(state.verificationResults),
      durationsByCase: state.executionResults.map((execution) => ({
        caseId: execution.caseId,
        title: caseTitles.get(execution.caseId) ?? execution.caseId,
        durationMs: Math.max(0, Date.parse(execution.completedAt) - Date.parse(execution.startedAt)),
      })),
      riskOutcomeMatrix: buildRiskOutcomeMatrix(state.testPlan, verificationByCase),
      recoveryFunnel: buildRecoveryFunnel(state.executionResults, state.verificationResults),
    },
    testCases: (state.testPlan?.cases ?? []).map((testCase) => {
      const execution = executionByCase.get(testCase.id);
      const verification = verificationByCase.get(testCase.id);
      return {
        caseId: testCase.id,
        title: testCase.title,
        goal: testCase.title,
        riskLevel: testCase.riskLevel,
        executionMode: testCase.executionMode,
        classification: verification?.classification ?? "inconclusive",
        confidence: confidenceFor(verification?.classification, execution),
        checkpointsReached:
          execution?.stepResults
            .filter((step) => step.status === "passed")
            .map((step) => `step ${step.stepIndex}`) ?? [],
        durationMs: execution
          ? Math.max(0, Date.parse(execution.completedAt) - Date.parse(execution.startedAt))
          : 0,
        attempts: execution?.attempts ?? 0,
        recoveryAttempts: (execution?.recoveryAttempts ?? []).map((attempt) => ({
          checkpoint: attempt.checkpoint,
          failureSummary: attempt.failureSummary,
          action: attempt.action,
          attempt: attempt.attempt,
          maxAttempts: attempt.maxAttempts,
          outcome: attempt.outcome,
        })),
        assertions: execution?.assertionResults ?? [],
        evidence: buildEvidenceLinks(execution),
        redactedRawResult: redactExecutionResult(execution),
      };
    }),
    findings: state.verificationResults
      .filter((result) => result.classification === "failed" && result.defectCandidate)
      .map((result) =>
        buildFinding(result, executionByCase.get(result.caseId), caseTitles.get(result.caseId)),
      ),
    governance: {
      scopeManifestVersion: state.targetManifest.targetId,
      testPlanId: state.testPlan?.id,
      testPlanVersion: state.testPlan?.version,
      approverName: state.approval?.reviewer,
      approvalDecision: state.approval?.decision,
      approvalDecidedAt: state.approval?.decidedAt,
      executionPolicy: `${state.targetManifest.runExecutionMode} mode; scope limited to ${state.targetManifest.allowedDomains.join(", ")}`,
      runtimeVersions: { nova: NOVA_VERSION },
      stateTransitions: inferStateTransitions(state.auditEvents),
      redactedAuditTimeline: state.auditEvents.map((event) => ({
        timestamp: event.timestamp,
        type: event.type,
        actor: event.actor,
        detail: redactDetail(event.detail, event.type),
      })),
    },
    footer: {
      generatedAt: new Date().toISOString(),
      reportVersion: `${NOVA_VERSION}+schema${REPORT_SCHEMA_VERSION}`,
    },
  };
}

function buildExecutiveSummary(state: TestRunState) {
  const distribution = countByClassification(state.verificationResults);
  const recoveryAttempts = state.executionResults.reduce(
    (sum, execution) => sum + execution.recoveryAttempts.length,
    0,
  );
  const approvalInterventions = state.auditEvents.filter(
    (event) => event.type === "plan_approved" || event.type === "plan_rejected",
  ).length;
  const defectCandidates = state.verificationResults.filter((result) => result.defectCandidate).length;
  const total = state.verificationResults.length;

  return {
    totalTests: total,
    passed: distribution.passed,
    failed: distribution.failed,
    flaky: distribution.flaky,
    blocked: distribution.blocked,
    inconclusive: distribution.inconclusive,
    recoveryAttempts,
    approvalInterventions,
    defectCandidates,
    outcomeStatement: buildOutcomeStatement(state.status, distribution, total),
  };
}

function buildOutcomeStatement(
  status: TestRunState["status"],
  distribution: ReturnType<typeof countByClassification>,
  total: number,
): string {
  if (total === 0) {
    return `Run ${status}: no test cases were verified yet.`;
  }
  if (distribution.failed > 0) {
    return `Run completed with ${distribution.failed} confirmed defect${distribution.failed === 1 ? "" : "s"} out of ${total} test case${total === 1 ? "" : "s"}.`;
  }
  if (distribution.blocked > 0) {
    return `Run blocked: ${distribution.blocked} of ${total} test case${total === 1 ? "" : "s"} could not run due to a policy or scope decision.`;
  }
  if (distribution.inconclusive > 0) {
    return `Run passed with ${distribution.inconclusive} inconclusive result${distribution.inconclusive === 1 ? "" : "s"} (harness limitation, not a defect).`;
  }
  return `All ${total} test case${total === 1 ? "" : "s"} passed.`;
}

function countByClassification(results: VerificationResult[]) {
  const counts = { passed: 0, failed: 0, flaky: 0, blocked: 0, inconclusive: 0 };
  for (const result of results) {
    counts[result.classification] += 1;
  }
  return counts;
}

function buildRiskOutcomeMatrix(
  testPlan: TestPlan | undefined,
  verificationByCase: Map<string, VerificationResult>,
) {
  const cells = new Map<
    string,
    { riskLevel: RiskLevel; classification: VerificationClassification; count: number }
  >();
  for (const testCase of testPlan?.cases ?? []) {
    const classification = verificationByCase.get(testCase.id)?.classification ?? "inconclusive";
    const key = `${testCase.riskLevel}:${classification}`;
    const existing = cells.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      cells.set(key, { riskLevel: testCase.riskLevel, classification, count: 1 });
    }
  }
  return [...cells.values()];
}

function buildRecoveryFunnel(executionResults: ExecutionResult[], verificationResults: VerificationResult[]) {
  const verificationByCase = new Map(verificationResults.map((result) => [result.caseId, result]));
  let failuresDetected = 0;
  let recoveryAttempted = 0;
  let recovered = 0;
  let confirmedDefect = 0;
  let blocked = 0;

  for (const execution of executionResults) {
    const hadStepFailure = execution.stepResults.some((step) => step.status === "failed");
    if (hadStepFailure) {
      failuresDetected += 1;
    }
    if (execution.recoveryAttempts.length > 0) {
      recoveryAttempted += 1;
      if (execution.recoveryAttempts.some((attempt) => attempt.outcome === "recovered")) {
        recovered += 1;
      }
    }
    const verification = verificationByCase.get(execution.caseId);
    if (verification?.classification === "failed") {
      confirmedDefect += 1;
    }
    if (verification?.classification === "blocked") {
      blocked += 1;
    }
  }

  return { failuresDetected, recoveryAttempted, recovered, confirmedDefect, blocked };
}

function confidenceFor(
  classification: VerificationClassification | undefined,
  execution: ExecutionResult | undefined,
): "high" | "medium" | "low" {
  if (classification === "inconclusive" || classification === "blocked") {
    return "low";
  }
  if (execution && execution.recoveryAttempts.length > 0) {
    return "medium";
  }
  return "high";
}

function buildEvidenceLinks(execution: ExecutionResult | undefined): ReportEvidenceLink[] {
  if (!execution) {
    return [];
  }
  const links: ReportEvidenceLink[] = execution.screenshots.map((path, index) => ({
    kind: "screenshot",
    label: `Screenshot ${index + 1}`,
    path,
  }));
  if (execution.tracePath) {
    links.push({ kind: "trace", label: "Playwright trace", path: execution.tracePath });
  }
  return links;
}

function redactExecutionResult(execution: ExecutionResult | undefined): Record<string, unknown> {
  if (!execution) {
    return {};
  }
  return {
    caseId: execution.caseId,
    attempts: execution.attempts,
    stepResults: execution.stepResults,
    assertionResults: execution.assertionResults,
    recoveryAttemptCount: execution.recoveryAttempts.length,
    consoleLogCount: execution.consoleLogs.length,
    error: execution.error,
  };
}

function classifyDefect(execution: ExecutionResult | undefined): DefectClassification {
  if (!execution) {
    return "infrastructure_failure";
  }
  if (execution.attempts > 1) {
    return "flaky_test";
  }
  if (execution.error && !execution.stepResults.some((step) => step.status === "failed")) {
    return "infrastructure_failure";
  }
  return "product_defect";
}

function buildFinding(
  verification: VerificationResult,
  execution: ExecutionResult | undefined,
  title: string | undefined,
): Finding {
  const failedStep = execution?.stepResults.find((step) => step.status === "failed");
  const failedAssertion = execution?.assertionResults.find((assertion) => !assertion.passed);

  return {
    caseId: verification.caseId,
    title: title ?? verification.caseId,
    severity: execution?.recoveryAttempts.some((attempt) => attempt.outcome !== "recovered")
      ? "high"
      : "medium",
    classification: classifyDefect(execution),
    observedBehavior:
      failedAssertion?.observed ??
      failedStep?.error ??
      verification.defectCandidate?.description ??
      "Unknown.",
    expectedBehavior: failedAssertion?.expected ?? "Step and assertions declared in the approved test plan.",
    reproductionPath: execution?.stepResults.map((step) => `Step ${step.stepIndex}: ${step.status}`) ?? [],
    affectedCheckpoint: failedStep ? `step ${failedStep.stepIndex}` : (failedAssertion?.kind ?? "unknown"),
    evidence: buildEvidenceLinks(execution),
    recoveryContinuedRun: (execution?.recoveryAttempts.length ?? 0) > 0,
  };
}

function buildTimeline(auditEvents: AuditEvent[]): TimelineStage[] {
  const stages: TimelineStage[] = [];
  let previousCompletedAt = auditEvents.at(0)?.timestamp;

  for (const stageId of STAGE_ORDER) {
    const completionEvent = auditEvents.find((event) => STAGE_COMPLETION_EVENT[stageId].includes(event.type));
    if (!completionEvent) {
      stages.push({ stage: stageId, status: "skipped" });
      continue;
    }
    const status = completionEvent.type === "plan_rejected" ? "interrupted" : "completed";
    const startedAt = previousCompletedAt;
    const elapsedMs =
      startedAt && completionEvent.timestamp
        ? Math.max(0, Date.parse(completionEvent.timestamp) - Date.parse(startedAt))
        : undefined;
    stages.push({
      stage: stageId,
      status,
      startedAt,
      completedAt: completionEvent.timestamp,
      elapsedMs,
      note: status === "interrupted" ? "Plan rejected; run stopped here." : undefined,
    });
    previousCompletedAt = completionEvent.timestamp;
  }

  return stages;
}

function inferStateTransitions(auditEvents: AuditEvent[]) {
  const transitions: Array<{ from?: string; to: string; at: string }> = [];
  let previousType: string | undefined;
  for (const event of auditEvents) {
    transitions.push({ from: previousType, to: event.type, at: event.timestamp });
    previousType = event.type;
  }
  return transitions;
}

function redactDetail(detail: Record<string, unknown>, eventType: string): Record<string, unknown> {
  const eventIsSecretRelated = /secret|password|token|credential/i.test(eventType);
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (eventIsSecretRelated || /secret|password|token|credential/i.test(key)) {
      redacted[key] = "[redacted]";
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}
