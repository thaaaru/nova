import { z } from "zod";

import { getCurrentRunId, type NovaRuntime } from "../../context.js";
import type { FieldSpec, ResolveInputsConfig } from "../resolve-inputs.js";

export const ReportInputSchema = z.object({
  run: z.string().min(1),
});
export type ReportInput = z.infer<typeof ReportInputSchema>;

/** Builds the guided field for `nova report`. Throws early, before any prompt, when there is nothing to report on. */
export function buildReportFields(runtime: NovaRuntime): FieldSpec[] {
  const runs = runtime.repository.list();
  if (runs.length === 0) {
    throw new Error("No runs found. Run `nova discover` or `nova map discover` first.");
  }
  const currentRunId = getCurrentRunId(runtime.config);
  return [
    {
      key: "run",
      flag: "--run",
      label: "Run to report on",
      kind: "select",
      choices: () =>
        runs.map((run) => ({
          label: `${run.runId}  ${run.status}  ${run.targetManifest.baseUrl}`,
          value: run.runId,
        })),
      defaultValue: () =>
        currentRunId && runs.some((run) => run.runId === currentRunId) ? currentRunId : runs[0]?.runId,
      parse: (raw) => {
        const run = runs.find((candidate) => candidate.runId === raw.trim());
        return run ? { ok: true, value: run.runId } : { ok: false, error: `Unknown run: ${raw}` };
      },
    },
  ];
}

export function reportResolveConfig(fields: FieldSpec[]): ResolveInputsConfig {
  return {
    title: "NOVA \u2014 Generate Report",
    fields,
    confirmLabel: "Generate reports for this run?",
    exampleCommand: "nova report --run <run-id>",
  };
}
