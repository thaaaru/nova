import { randomUUID } from "node:crypto";

import { writeReportFiles } from "../../artifacts/write-reports.js";
import type { GraphState } from "../state.js";

export type ReportDependencies = {
  artifactsDirectory: string;
};

/**
 * Node 6: report. Generates JSON, JUnit XML, and Markdown from the run's
 * final state and registers each as an ArtifactReference — every finding
 * a report shows is traceable back to the evidence file it came from.
 */
export function createReportNode(deps: ReportDependencies) {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    const written = writeReportFiles(run, deps.artifactsDirectory);

    const artifactReferences = [
      ...run.artifactReferences,
      { id: randomUUID(), kind: "report" as const, path: written.jsonPath },
      { id: randomUUID(), kind: "report" as const, path: written.junitPath },
      { id: randomUUID(), kind: "report" as const, path: written.markdownPath },
    ];

    return {
      run: {
        ...run,
        artifactReferences,
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "report_generated",
            detail: {
              jsonPath: written.jsonPath,
              junitPath: written.junitPath,
              markdownPath: written.markdownPath,
            },
            actor: "system",
          },
        ],
      },
    };
  };
}
