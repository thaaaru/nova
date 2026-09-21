import type { WrittenReportPaths } from "../../artifacts/write-reports.js";
import type { NovaRuntime } from "../context.js";
import type { ApproveResult, DiscoverResult, ExecutionResultSummary, PlanResult } from "../commands.js";
import { runApprove, runExecution, runPlan, runReport } from "../commands.js";
import type { PromptSession } from "./prompt-io.js";

/**
 * What actually happened once the operator was offered the guided
 * continuation. Each stage is present only if the operator reached and
 * completed it — `nova discover`'s caller uses whichever stage is last
 * present to print the exact next command, same as the non-interactive
 * path already does at each stand-alone command.
 */
export type DiscoverWizardResult =
  | { proceeded: false }
  | {
      proceeded: true;
      plan: PlanResult;
      approval?: ApproveResult;
      execution?: ExecutionResultSummary;
      report?: WrittenReportPaths;
    };

/**
 * Immediately after a successful `nova discover`, offers to keep walking
 * the operator through plan -> approve -> run -> report in the same
 * terminal session instead of making them copy-paste each generated
 * "Next:" command by hand. Declining (or a non-TTY/CI/`--non-interactive`
 * caller, which never calls this at all — see src/cli/index.ts) leaves
 * the classic command-at-a-time flow completely unchanged.
 *
 * Every stage is a real call into the same commands.ts functions the
 * stand-alone `nova plan`/`nova approve`/`nova run`/`nova report`
 * commands use — this is a thin guided sequencing layer, not a second
 * implementation of any of them.
 */
export async function runDiscoverWizard(
  runtime: NovaRuntime,
  session: PromptSession,
  discovered: DiscoverResult,
): Promise<DiscoverWizardResult> {
  const proceed = await session.confirm(
    "Continue into the guided plan -> approve -> run -> report flow now?",
  );
  if (!proceed) {
    return { proceeded: false };
  }

  const objective = await session.line("What should this run test?");
  if (!objective) {
    return { proceeded: false };
  }
  const plan = await runPlan(runtime, { objective, run: discovered.runId });

  const approveNow = await session.confirm(`Approve plan ${plan.planId} and run it now?`);
  if (!approveNow) {
    return { proceeded: true, plan };
  }

  const reviewer = await session.line(
    "Reviewer name (recorded in the audit log)",
    process.env.NOVA_REVIEWER ?? process.env.USER ?? "cli-operator",
  );
  const approval = await runApprove(runtime, { plan: plan.planId, reviewer });
  if (approval.decision !== "approved") {
    return { proceeded: true, plan, approval };
  }

  const execution = await runExecution(runtime, { plan: approval.runId });
  const report = runReport(runtime, { run: execution.runId });

  return { proceeded: true, plan, approval, execution, report };
}
