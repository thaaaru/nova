import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TestRunState } from "../domain/index.js";
import {
  buildJsonReport,
  buildJUnitReport,
  buildMarkdownReport,
} from "../services/reporting/report-generator.js";

export type WrittenReportPaths = {
  jsonPath: string;
  junitPath: string;
  markdownPath: string;
};

export function writeReportFiles(state: TestRunState, artifactsDirectory: string): WrittenReportPaths {
  const outputDirectory = join(artifactsDirectory, state.runId, "report");
  mkdirSync(outputDirectory, { recursive: true });

  const jsonPath = join(outputDirectory, "report.json");
  const junitPath = join(outputDirectory, "junit.xml");
  const markdownPath = join(outputDirectory, "report.md");

  writeFileSync(jsonPath, JSON.stringify(buildJsonReport(state), null, 2));
  writeFileSync(junitPath, buildJUnitReport(state));
  writeFileSync(markdownPath, buildMarkdownReport(state));

  return { jsonPath, junitPath, markdownPath };
}
