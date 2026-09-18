import type { TestRunState } from "../../domain/index.js";

const NOVA_VERSION = "0.1.0";

export type RunReport = {
  runId: string;
  testPlanId: string | undefined;
  testPlanVersion: number | undefined;
  environment: string | undefined;
  generatedAt: string;
  novaVersion: string;
  status: string;
  cases: Array<{
    caseId: string;
    title: string | undefined;
    classification: string;
    evidenceRefs: string[];
    defectCandidate: { title: string; description: string; evidenceRefs: string[] } | undefined;
  }>;
};

/** Machine-readable JSON report. Every finding links back to its evidence via artifactReferences. */
export function buildJsonReport(state: TestRunState): RunReport {
  const caseTitles = new Map(state.testPlan?.cases.map((testCase) => [testCase.id, testCase.title]));
  return {
    runId: state.runId,
    testPlanId: state.testPlan?.id,
    testPlanVersion: state.testPlan?.version,
    environment: state.targetManifest.environment,
    generatedAt: new Date().toISOString(),
    novaVersion: NOVA_VERSION,
    status: state.status,
    cases: state.verificationResults.map((result) => ({
      caseId: result.caseId,
      title: caseTitles.get(result.caseId),
      classification: result.classification,
      evidenceRefs: result.evidenceRefs,
      defectCandidate: result.defectCandidate,
    })),
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** JUnit XML for CI integration — one <testcase> per verified TestCase. */
export function buildJUnitReport(state: TestRunState): string {
  const caseTitles = new Map(state.testPlan?.cases.map((testCase) => [testCase.id, testCase.title]));
  const failures = state.verificationResults.filter((result) => result.classification === "failed").length;

  const testCases = state.verificationResults
    .map((result) => {
      const title = caseTitles.get(result.caseId) ?? result.caseId;
      const execution = state.executionResults.find((execResult) => execResult.caseId === result.caseId);
      const durationSeconds = execution
        ? (new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime()) / 1000
        : 0;

      if (result.classification === "passed") {
        return `    <testcase name="${xmlEscape(title)}" classname="${xmlEscape(result.caseId)}" time="${durationSeconds}" />`;
      }

      const failureMessage = result.defectCandidate?.description ?? result.classification;
      return (
        `    <testcase name="${xmlEscape(title)}" classname="${xmlEscape(result.caseId)}" time="${durationSeconds}">\n` +
        `      <failure message="${xmlEscape(failureMessage)}">${xmlEscape(result.classification)}</failure>\n` +
        `    </testcase>`
      );
    })
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuite name="Nova run ${xmlEscape(state.runId)}" tests="${state.verificationResults.length}" failures="${failures}">\n` +
    `${testCases}\n` +
    `</testsuite>\n`
  );
}

/** Human-readable executive summary. */
export function buildMarkdownReport(state: TestRunState): string {
  const caseTitles = new Map(state.testPlan?.cases.map((testCase) => [testCase.id, testCase.title]));
  const passed = state.verificationResults.filter((result) => result.classification === "passed").length;
  const failed = state.verificationResults.filter((result) => result.classification === "failed").length;
  const other = state.verificationResults.length - passed - failed;

  const lines: string[] = [
    `# Nova test run report`,
    "",
    `- Run ID: \`${state.runId}\``,
    `- Test plan: \`${state.testPlan?.id ?? "(none)"}\` (version ${state.testPlan?.version ?? "-"})`,
    `- Environment: ${state.targetManifest.environment}`,
    `- Target: ${state.targetManifest.baseUrl}`,
    `- Status: ${state.status}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Nova version: ${NOVA_VERSION}`,
    "",
    `## Summary`,
    "",
    `${passed} passed, ${failed} failed, ${other} other, out of ${state.verificationResults.length} case(s).`,
    "",
    `## Cases`,
    "",
  ];

  for (const result of state.verificationResults) {
    const title = caseTitles.get(result.caseId) ?? result.caseId;
    lines.push(`### ${title} — ${result.classification}`);
    lines.push("");
    if (result.defectCandidate) {
      lines.push(`**Defect candidate:** ${result.defectCandidate.title}`);
      lines.push("");
      lines.push(result.defectCandidate.description);
      lines.push("");
    }
    if (result.evidenceRefs.length > 0) {
      lines.push(`Evidence: ${result.evidenceRefs.join(", ")}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
