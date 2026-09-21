#!/usr/bin/env node
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Command, Option } from "commander";

import { buildRuntime } from "./context.js";
import { loadConfig } from "../config/index.js";
import { runApprove, runDiscover, runExecution, runPlan, runReport } from "./commands.js";
import { serveMcp } from "../mcp/server.js";
import { runTui } from "../tui/index.js";
import { captureStorageState } from "../services/browser/login.js";
import type { UserJourney, VerificationResult } from "../domain/index.js";
import {
  approveJourney,
  confirmRun,
  describeTest,
  discoverMap,
  getMap,
  listAreas,
  listJourneys,
  listMaps,
  recommendations,
  runJourney,
} from "../services/testmap/map-service.js";
import { detectInteractivity, type InteractivityOptions } from "./interactive/interactivity.js";
import { createPromptSession, defaultPromptIO, isInteractiveTTY } from "./interactive/prompt-io.js";
import {
  CancelledInputError,
  NonInteractiveInputError,
  resolveInputs,
} from "./interactive/resolve-inputs.js";
import { MapDiscoverInputSchema, mapDiscoverResolveConfig } from "./interactive/commands/map-discover.js";
import {
  JourneyRunInputSchema,
  buildJourneyRunFields,
  journeyRunResolveConfig,
} from "./interactive/commands/journey-run.js";
import {
  JourneyApproveInputSchema,
  buildJourneyApproveFields,
  journeyApproveResolveConfig,
} from "./interactive/commands/journey-approve.js";
import { ReportInputSchema, buildReportFields, reportResolveConfig } from "./interactive/commands/report.js";
import { runDiscoverWizard } from "./interactive/discover-wizard.js";
import { checkForUpdatesIfDue } from "../services/update-check/index.js";

/** Commander's recipe for a repeatable option (e.g. `--fixture a --fixture b`). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Added to every guided command; `--interactive` also works when a required value is a positional argument. */
function withInteractivityOptions(command: Command): Command {
  return command
    .addOption(new Option("--interactive", "Force guided review, even when every input is already supplied"))
    .addOption(new Option("--non-interactive", "Never prompt; fail with every missing input listed at once"));
}

/** The highest checkpoint risk level on a journey — display-only, mirrors the same precedence map-to-plan.ts uses to pick a case's risk level. */
function journeyRiskLevel(journey: UserJourney): string {
  if (journey.checkpoints.some((checkpoint) => checkpoint.riskLevel === "high")) {
    return "high";
  }
  if (journey.checkpoints.some((checkpoint) => checkpoint.riskLevel === "medium")) {
    return "medium";
  }
  return "low";
}

/** Same classification-tallying the plain `run` command already prints, applied to a run fetched after journey confirmation. */
function classificationCounts(results: VerificationResult[]): Record<string, number> {
  return results.reduce<Record<string, number>>((counts, verification) => {
    counts[verification.classification] = (counts[verification.classification] ?? 0) + 1;
    return counts;
  }, {});
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const program = new Command();
program
  .name("nova")
  .description("Nova: a governed AI orchestration runtime for web application test automation.");

program
  .command("init")
  .description("Scaffold local directories and a sample scope manifest.")
  .action(() => {
    const config = loadConfig();
    mkdirSync(dirname(config.databasePath), { recursive: true });
    mkdirSync(config.artifactsDirectory, { recursive: true });
    const samplePath = resolve(__dirname, "../../fixtures/sample-manifest.json");
    const destination = resolve("nova.manifest.json");
    if (!existsSync(destination) && existsSync(samplePath)) {
      copyFileSync(samplePath, destination);
      process.stdout.write(`Wrote a sample manifest to ${destination} — edit allowedDomains before use.\n`);
    }
    process.stdout.write(`Initialized ${dirname(config.databasePath)} and ${config.artifactsDirectory}.\n`);
    process.stdout.write("Next: nova discover --target <url>\n");
  });

const discoverCommand = withInteractivityOptions(
  program
    .command("discover")
    .description("Crawl a target and capture a read-only application map.")
    .requiredOption("--target <url>", "Target application URL")
    .option("--manifest <path>", "Path to an approved TargetManifest JSON file")
    .option(
      "--storage-state <path>",
      "Path to a session captured by `nova login` — crawl as that signed-in user",
    )
    .option("--no-headless", "Run the browser headed"),
);
discoverCommand.action(
  async (options: {
    target: string;
    manifest?: string;
    storageState?: string;
    headless: boolean;
    interactive?: boolean;
    nonInteractive?: boolean;
  }) => {
    const runtime = buildRuntime();
    try {
      const result = await runDiscover(runtime, {
        target: options.target,
        manifest: options.manifest,
        storageState: options.storageState,
        headless: options.headless,
      });
      process.stdout.write(`Run ${result.runId}: discovered ${result.pageCount} page(s).\n`);

      const interactivity = detectInteractivity(options as InteractivityOptions);
      if (!interactivity.promptingAllowed) {
        process.stdout.write(`Next: nova plan --objective "<your objective>" --run ${result.runId}\n`);
        return;
      }

      const session = createPromptSession();
      try {
        const wizard = await runDiscoverWizard(runtime, session, result);
        if (!wizard.proceeded) {
          process.stdout.write(`Next: nova plan --objective "<your objective>" --run ${result.runId}\n`);
          return;
        }
        process.stdout.write(
          `Plan ${wizard.plan.planId} ready for review: ${wizard.plan.cases.length} case(s).\n`,
        );
        for (const testCase of wizard.plan.cases) {
          process.stdout.write(
            `  [${testCase.riskLevel}/${testCase.executionMode}] ${testCase.id}: ${testCase.title}\n`,
          );
        }
        if (!wizard.approval) {
          process.stdout.write(`Next: nova approve --plan ${wizard.plan.planId}\n`);
          return;
        }
        process.stdout.write(`Plan ${wizard.approval.runId} ${wizard.approval.decision}.\n`);
        if (wizard.approval.decision !== "approved" || !wizard.execution) {
          return;
        }
        process.stdout.write(`Run ${wizard.execution.runId} finished: ${wizard.execution.status}.\n`);
        process.stdout.write(`${JSON.stringify(wizard.execution.classificationCounts)}\n`);
        if (!wizard.report) {
          process.stdout.write(`Next: nova report --run ${wizard.execution.runId}\n`);
          return;
        }
        process.stdout.write(`JSON:     ${wizard.report.jsonPath}\n`);
        process.stdout.write(`JUnit:    ${wizard.report.junitPath}\n`);
        process.stdout.write(`Markdown: ${wizard.report.markdownPath}\n`);
        process.stdout.write(`HTML:     ${wizard.report.htmlPath}\n`);
      } finally {
        session.close();
      }
    } finally {
      runtime.repository.close();
    }
  },
);

program
  .command("login")
  .description(
    "Open a headed browser, sign in by hand, and save the session for --storage-state on discover/map discover.",
  )
  .requiredOption("--url <url>", "Target application URL to open")
  .requiredOption(
    "--save-storage-state <path>",
    "Where to write the captured session (cookies + localStorage)",
  )
  .action(async (options: { url: string; saveStorageState: string }) => {
    const session = createPromptSession();
    try {
      process.stdout.write(`Opening ${options.url} — sign in in the browser window, then return here.\n`);
      const result = await captureStorageState({
        url: options.url,
        outputPath: options.saveStorageState,
        waitForOperator: async () => {
          await session.line("Press Enter once you are signed in");
        },
      });
      process.stdout.write(`Saved session to ${result.outputPath} (permissions 0600).\n`);
      process.stdout.write(
        `Next: nova discover --target ${options.url} --storage-state ${result.outputPath}\n`,
      );
    } finally {
      session.close();
    }
  });

program
  .command("plan")
  .description("Generate a reviewable TestPlan from a discovered run and an objective.")
  .requiredOption("--objective <text>", "What this run should test")
  .option("--run <runId>", "Run id (defaults to the most recently discovered run)")
  .action(async (options: { objective: string; run?: string }) => {
    const runtime = buildRuntime();
    try {
      const result = await runPlan(runtime, options);
      process.stdout.write(`Plan ${result.planId} ready for review: ${result.cases.length} case(s).\n`);
      for (const testCase of result.cases) {
        process.stdout.write(
          `  [${testCase.riskLevel}/${testCase.executionMode}] ${testCase.id}: ${testCase.title}\n`,
        );
      }
      process.stdout.write(`Next: nova approve --plan ${result.planId}\n`);
    } finally {
      runtime.repository.close();
    }
  });

program
  .command("approve")
  .description("Approve (or reject) a TestPlan. No execution can happen before this.")
  .requiredOption("--plan <planId>", "Plan id (same as the run id)")
  .option("--reviewer <name>", "Reviewer identity recorded in the audit log")
  .option("--reject", "Reject instead of approve", false)
  .option("--note <text>", "Optional note recorded with the decision")
  .action(async (options: { plan: string; reviewer?: string; reject: boolean; note?: string }) => {
    const runtime = buildRuntime();
    try {
      const result = await runApprove(runtime, options);
      process.stdout.write(`Plan ${result.runId} ${result.decision}.\n`);
      if (result.decision === "approved") {
        process.stdout.write(`Next: nova run --plan ${result.runId}\n`);
      }
    } finally {
      runtime.repository.close();
    }
  });

program
  .command("run")
  .description("Execute an approved TestPlan's cases, then verify and report.")
  .requiredOption("--plan <planId>", "Plan id (same as the run id)")
  .option("--no-headless", "Run the browser headed")
  .action(async (options: { plan: string; headless: boolean }) => {
    const runtime = buildRuntime();
    try {
      const result = await runExecution(runtime, options);
      process.stdout.write(`Run ${result.runId} finished: ${result.status}.\n`);
      process.stdout.write(`${JSON.stringify(result.classificationCounts)}\n`);
      process.stdout.write(`Next: nova report --run ${result.runId}\n`);
    } finally {
      runtime.repository.close();
    }
  });

const reportCommand = withInteractivityOptions(
  program
    .command("report")
    .description("(Re)generate JSON, JUnit, Markdown, and self-contained HTML reports for a run.")
    .option("--run <runId>", "Run id"),
);
reportCommand.action(async (options: { run?: string; interactive?: boolean; nonInteractive?: boolean }) => {
  const runtime = buildRuntime();
  try {
    const interactivity = detectInteractivity(options as InteractivityOptions);
    const fields = buildReportFields(runtime);
    const resolved = await resolveInputs(reportResolveConfig(fields), { run: options.run }, interactivity);
    const input = ReportInputSchema.parse(resolved);
    const written = runReport(runtime, { run: input.run });
    process.stdout.write(`JSON:     ${written.jsonPath}\n`);
    process.stdout.write(`JUnit:    ${written.junitPath}\n`);
    process.stdout.write(`Markdown: ${written.markdownPath}\n`);
    process.stdout.write(`HTML:     ${written.htmlPath}\n`);
  } finally {
    runtime.repository.close();
  }
});

const mapCommand = program.command("map").description("Manage Application Test Maps.");

const mapDiscoverCommand = withInteractivityOptions(
  mapCommand
    .command("discover")
    .description(
      "Crawl a target and draft a new Application Test Map (draft until its journeys are approved).",
    )
    .option("--target <url>", "Target application URL")
    .option("--name <applicationName>", "Name for the new map's application")
    .option("--env <environment>", "local|development|staging|production")
    .option(
      "--storage-state <path>",
      "Path to a session captured by `nova login` — every journey run against this map reuses it",
    )
    .option("--no-headless", "Run the browser headed"),
);
mapDiscoverCommand.action(
  async (options: {
    target?: string;
    name?: string;
    env?: string;
    storageState?: string;
    headless: boolean;
    interactive?: boolean;
    nonInteractive?: boolean;
  }) => {
    const runtime = buildRuntime();
    try {
      const interactivity = detectInteractivity(options as InteractivityOptions);
      const resolved = await resolveInputs(
        mapDiscoverResolveConfig,
        { target: options.target, name: options.name, env: options.env },
        interactivity,
      );
      const input = MapDiscoverInputSchema.parse(resolved);
      const result = await discoverMap(runtime, {
        target: input.target,
        applicationName: input.name,
        environment: input.env,
        storageStatePath: options.storageState,
        headless: options.headless,
      });
      const journeyCount = result.map.areas.reduce((total, area) => total + area.journeys.length, 0);
      process.stdout.write(
        `Map ${result.map.id} drafted: ${result.map.areas.length} area(s), ${journeyCount} draft journey(s).\n`,
      );
      process.stdout.write("This map is a draft until a QA engineer reviews and approves its journeys.\n");
      process.stdout.write(`Next: nova map show ${result.map.id}\n`);
    } finally {
      runtime.repository.close();
    }
  },
);

mapCommand
  .command("list")
  .description("List every Application Test Map.")
  .action(() => {
    const runtime = buildRuntime();
    try {
      const maps = listMaps(runtime);
      if (maps.length === 0) {
        process.stdout.write("No application test maps yet. Run `nova map discover` first.\n");
      }
      for (const map of maps) {
        process.stdout.write(
          `${map.id}  ${map.applicationName}  [${map.environment}]  ${map.status}  v${map.version}\n`,
        );
      }
    } finally {
      runtime.repository.close();
    }
  });

mapCommand
  .command("show <mapId>")
  .description("Show one map's full area/journey tree.")
  .action((mapId: string) => {
    const runtime = buildRuntime();
    try {
      const map = getMap(runtime, mapId);
      if (!map) {
        throw new Error(`Unknown application test map: ${mapId}`);
      }
      process.stdout.write(
        `${map.id}  ${map.applicationName}  [${map.environment}]  ${map.status}  v${map.version}\n`,
      );
      for (const area of map.areas) {
        process.stdout.write(`- ${area.name} (${area.id})  risk=${area.riskLevel}\n`);
        for (const journey of area.journeys) {
          process.stdout.write(
            `    * ${journey.name} (${journey.id})  mode=${journey.mode}  status=${journey.status}  risk=${journeyRiskLevel(journey)}\n`,
          );
        }
      }

      // Generated here, not left for the operator to assemble: the exact
      // command to run next for every actionable journey, with the map id
      // and journey id already filled in.
      const draftJourneys = map.areas.flatMap((area) =>
        area.journeys.filter((journey) => journey.status === "draft"),
      );
      const approvedJourneys = map.areas.flatMap((area) =>
        area.journeys.filter((journey) => journey.status === "approved"),
      );
      if (draftJourneys.length > 0 || approvedJourneys.length > 0) {
        process.stdout.write("\nNext (copy/paste):\n");
        for (const journey of draftJourneys) {
          process.stdout.write(`  nova journey approve ${journey.id} --map ${map.id} --non-interactive\n`);
        }
        for (const journey of approvedJourneys) {
          process.stdout.write(`  nova journey run ${journey.id} --map ${map.id} --non-interactive\n`);
        }
      }
    } finally {
      runtime.repository.close();
    }
  });

program
  .command("wizard <mapId>")
  .description(
    "Walk an Application Test Map end to end: approve, run, confirm, and report every actionable journey. Nothing to copy or paste.",
  )
  .option("--reviewer <name>", "Reviewer identity recorded for guided_test/controlled_test confirmations")
  .option("--non-interactive", "Run every step immediately with no confirmation prompts")
  .action(async (mapId: string, options: { reviewer?: string; nonInteractive?: boolean }) => {
    const runtime = buildRuntime();
    const io = defaultPromptIO;
    const auto = Boolean(options.nonInteractive) || !isInteractiveTTY(io);
    const session = auto ? undefined : createPromptSession(io);
    try {
      const map = getMap(runtime, mapId);
      if (!map) {
        throw new Error(`Unknown application test map: ${mapId}`);
      }
      const reviewer = options.reviewer ?? process.env.NOVA_REVIEWER ?? "cli-operator";
      const actionable = listJourneys(runtime, mapId).filter(
        (journey) => journey.status === "draft" || journey.status === "approved",
      );
      if (actionable.length === 0) {
        process.stdout.write(
          `Nothing to do: ${map.applicationName} has no draft or approved journeys left to run.\n`,
        );
        return;
      }
      const reportRunIds: string[] = [];
      for (const journey of actionable) {
        let current = journey;
        if (current.status === "draft") {
          if (session && !(await session.confirm(`Approve "${current.name}" (${current.id})?`))) {
            process.stdout.write(`Skipped ${current.id} (left as draft).\n`);
            continue;
          }
          current = approveJourney(runtime, mapId, current.id);
          process.stdout.write(`Approved ${current.id}.\n`);
        }
        if (session && !(await session.confirm(`Run "${current.name}" (${current.id})?`))) {
          process.stdout.write(`Skipped ${current.id} (not run).\n`);
          continue;
        }
        // Persona/fixtures are intrinsic to the journey, not a free choice — same
        // auto-fill `nova journey run` already applies (see TestContextScreen.tsx).
        const prepared = await runJourney(runtime, {
          mapId,
          journeyId: current.id,
          environment: map.environment,
          personaId: current.requiredPersonaIds.length === 1 ? current.requiredPersonaIds[0] : undefined,
          fixtureIds: current.requiredFixtureIds,
        });
        if (prepared.status === "awaiting_approval") {
          process.stdout.write(
            `Run ${prepared.runId} staged for review (${prepared.mode}): ${prepared.cases.length} case(s).\n`,
          );
          if (session && !(await session.confirm(`Confirm run ${prepared.runId} as "${reviewer}"?`))) {
            process.stdout.write(`Skipped confirming ${prepared.runId}.\n`);
            continue;
          }
          const result = await confirmRun(runtime, prepared.runId, reviewer);
          process.stdout.write(`Run ${result.runId} finished: ${result.status}.\n`);
          process.stdout.write(`${JSON.stringify(result.classificationCounts)}\n`);
        } else {
          process.stdout.write(`Run ${prepared.runId} finished: ${prepared.status} (${prepared.mode}).\n`);
        }
        reportRunIds.push(prepared.runId);
      }
      for (const runId of reportRunIds) {
        const written = runReport(runtime, { run: runId });
        process.stdout.write(`Report for ${runId}: ${written.htmlPath}\n`);
      }
      process.stdout.write(
        `\nWizard complete: ${reportRunIds.length} journey run(s) executed and reported for ${map.applicationName}.\n`,
      );
    } finally {
      session?.close();
      runtime.repository.close();
    }
  });

const areaCommand = program.command("area").description("Inspect an Application Test Map's areas.");

areaCommand
  .command("list")
  .description("List a map's application areas.")
  .requiredOption("--map <mapId>", "Application Test Map id")
  .action((options: { map: string }) => {
    const runtime = buildRuntime();
    try {
      const areas = listAreas(runtime, options.map);
      for (const area of areas) {
        process.stdout.write(
          `${area.id}  ${area.name}  risk=${area.riskLevel}  journeys=${area.journeys.length}\n`,
        );
      }
    } finally {
      runtime.repository.close();
    }
  });

const journeyCommand = program
  .command("journey")
  .description("Inspect, approve, and run journeys within an Application Test Map.");

journeyCommand
  .command("list")
  .description("List journeys in a map, optionally filtered to one area.")
  .requiredOption("--map <mapId>", "Application Test Map id")
  .option("--area <areaId>", "Filter to one area")
  .action((options: { map: string; area?: string }) => {
    const runtime = buildRuntime();
    try {
      const journeys = listJourneys(runtime, options.map, options.area);
      for (const journey of journeys) {
        process.stdout.write(
          `${journey.id}  ${journey.name}  mode=${journey.mode}  status=${journey.status}  ` +
            `risk=${journeyRiskLevel(journey)}  lastRunOutcome=${journey.lastRunOutcome ?? "never_run"}\n`,
        );
      }
    } finally {
      runtime.repository.close();
    }
  });

const journeyApproveCommand = withInteractivityOptions(
  journeyCommand
    .command("approve [journeyId]")
    .description("Approve a journey so it becomes runnable.")
    .option("--map <mapId>", "Application Test Map id"),
);
journeyApproveCommand.action(
  async (
    journeyId: string | undefined,
    options: { map?: string; interactive?: boolean; nonInteractive?: boolean },
  ) => {
    const runtime = buildRuntime();
    try {
      const interactivity = detectInteractivity(options as InteractivityOptions);
      const fields = buildJourneyApproveFields(runtime);
      const resolved = await resolveInputs(
        journeyApproveResolveConfig(fields),
        { map: options.map, journeyId },
        interactivity,
      );
      const input = JourneyApproveInputSchema.parse(resolved);
      const journey = approveJourney(runtime, input.map, input.journeyId);
      process.stdout.write(`Journey ${journey.id} is now "${journey.status}".\n`);
      if (journey.status === "approved") {
        process.stdout.write(`Next: nova journey run ${journey.id} --map ${input.map} --non-interactive\n`);
      }
    } finally {
      runtime.repository.close();
    }
  },
);

// quick_test journeys execute immediately (Nova's own "system:quick_test_policy"
// reviewer confirms them per journey-run-service.ts) and this command prints
// their final outcome directly. guided_test/controlled_test journeys stage a
// run at "awaiting_approval" instead: rather than pointing the operator at the
// lower-level `nova approve`/`nova run` pair (which know nothing about a
// journey's fixture locks or its recorded run outcome), `nova journey run`
// points at the single `nova journey confirm` command below, which calls the
// same confirmJourneyRun used by the quick_test path — one explicit human
// confirmation step, consistent with how startJourneyRun already treats the
// two mode families differently.
const journeyRunCommand = withInteractivityOptions(
  journeyCommand
    .command("run [journeyId]")
    .description(
      "Run a journey. quick_test executes immediately; guided_test/controlled_test stage for confirmation.",
    )
    .option("--map <mapId>", "Application Test Map id")
    .option("--env <environment>", "Environment to run against")
    .option("--persona <personaId>", "Persona id to run as")
    .option(
      "--fixture <fixtureId>",
      "Fixture id required by the journey (repeatable)",
      collect,
      [] as string[],
    ),
);
journeyRunCommand.action(
  async (
    journeyId: string | undefined,
    options: {
      map?: string;
      env?: string;
      persona?: string;
      fixture: string[];
      interactive?: boolean;
      nonInteractive?: boolean;
    },
  ) => {
    const runtime = buildRuntime();
    try {
      const interactivity = detectInteractivity(options as InteractivityOptions);
      const fields = buildJourneyRunFields(runtime);
      const resolved = await resolveInputs(
        journeyRunResolveConfig(fields),
        { map: options.map, journeyId, env: options.env },
        interactivity,
      );
      const input = JourneyRunInputSchema.parse(resolved);
      const journey = listJourneys(runtime, input.map).find((candidate) => candidate.id === input.journeyId);
      if (!journey) {
        throw new Error(`Unknown journey: ${input.journeyId}`);
      }
      // A journey's required persona/fixtures are intrinsic, not a free choice (see
      // TestContextScreen.tsx in the TUI) — auto-fill them here exactly as the TUI
      // does, rather than making an operator retype what the journey already declares.
      const personaId =
        options.persona ??
        (journey.requiredPersonaIds.length === 1 ? journey.requiredPersonaIds[0] : undefined);
      const fixtureIds = options.fixture.length > 0 ? options.fixture : journey.requiredFixtureIds;
      const prepared = await runJourney(runtime, {
        mapId: input.map,
        journeyId: input.journeyId,
        environment: input.env,
        personaId,
        fixtureIds,
      });
      if (prepared.status === "awaiting_approval") {
        process.stdout.write(
          `Run ${prepared.runId} staged for review (${prepared.mode}): ${prepared.cases.length} case(s).\n`,
        );
        for (const testCase of prepared.cases) {
          process.stdout.write(
            `  [${testCase.riskLevel}/${testCase.executionMode}] ${testCase.id}: ${testCase.title}\n`,
          );
        }
        process.stdout.write(`Next: nova journey confirm ${prepared.runId} --reviewer <name>\n`);
      } else {
        const finished = runtime.repository.get(prepared.runId);
        process.stdout.write(`Run ${prepared.runId} finished: ${prepared.status} (${prepared.mode}).\n`);
        process.stdout.write(
          `${JSON.stringify(classificationCounts(finished?.verificationResults ?? []))}\n`,
        );
        process.stdout.write(`Next: nova report --run ${prepared.runId} --non-interactive\n`);
      }
    } finally {
      runtime.repository.close();
    }
  },
);

journeyCommand
  .command("confirm <runId>")
  .description(
    "Confirm a staged guided_test/controlled_test run: approves it, executes it, and records the journey's outcome.",
  )
  .option("--reviewer <name>", "Reviewer identity recorded in the audit log")
  .action(async (runId: string, options: { reviewer?: string }) => {
    const runtime = buildRuntime();
    try {
      const reviewer = options.reviewer ?? process.env.NOVA_REVIEWER ?? "cli-operator";
      const result = await confirmRun(runtime, runId, reviewer);
      process.stdout.write(`Run ${result.runId} finished: ${result.status}.\n`);
      process.stdout.write(`${JSON.stringify(result.classificationCounts)}\n`);
      process.stdout.write(`Next: nova report --run ${result.runId} --non-interactive\n`);
    } finally {
      runtime.repository.close();
    }
  });

journeyCommand
  .command("describe <mapId> <requestText>")
  .description(
    "Match free text against a map's journeys, or propose a draft journey when nothing matches well.",
  )
  .action((mapId: string, requestText: string) => {
    const runtime = buildRuntime();
    try {
      const match = describeTest(runtime, mapId, requestText);
      if (match.kind === "matched") {
        process.stdout.write(
          `Matched journey ${match.journey.id} (${match.journey.name}) in area ${match.area.name} — score ${match.score.toFixed(2)}.\n`,
        );
      } else {
        process.stdout.write(
          `No confident match (best score ${match.bestScore.toFixed(2)}). ` +
            `Proposed draft journey "${match.draftJourney.name}" in area ${match.nearestAreaId ?? "unassigned"}.\n`,
        );
      }
    } finally {
      runtime.repository.close();
    }
  });

program
  .command("recommendations")
  .description("List deterministic regression-run recommendations for a map.")
  .requiredOption("--map <mapId>", "Application Test Map id")
  .action(async (options: { map: string }) => {
    const runtime = buildRuntime();
    try {
      const results = await recommendations(runtime, options.map);
      if (results.length === 0) {
        process.stdout.write("No regression journeys recommended right now.\n");
      }
      results.forEach((recommendation, index) => {
        const riskLabel =
          recommendation.riskLevel.charAt(0).toUpperCase() + recommendation.riskLevel.slice(1);
        process.stdout.write(
          `${index + 1}. ${recommendation.journeyName} — ${riskLabel} risk — ${recommendation.reason}\n`,
        );
      });
    } finally {
      runtime.repository.close();
    }
  });

program
  .command("mcp")
  .command("serve")
  .description("Start Nova's MCP server over stdio, for an IDE/CLI agent to connect to.")
  .action(async () => {
    await serveMcp();
  });

program
  .command("tui")
  .description("Launch Nova's interactive terminal UI.")
  .action(async () => {
    const runtime = buildRuntime();
    try {
      await runTui(runtime);
    } finally {
      runtime.repository.close();
    }
  });

async function main(): Promise<void> {
  // Best-effort, silent-on-failure: never delays a command by more than
  // its own short internal timeout, and never runs at all in CI or when
  // NOVA_NO_UPDATE_CHECK is set. Always stderr, never stdout — `nova mcp
  // serve` uses stdout as its JSON-RPC transport and must stay untouched.
  try {
    const notice = await checkForUpdatesIfDue({ databasePath: loadConfig().databasePath });
    if (notice) {
      process.stderr.write(`${notice}\n\n`);
    }
  } catch {
    // Never let the update check itself fail a command.
  }

  await program.parseAsync();
}

main().catch((error: unknown) => {
  if (error instanceof CancelledInputError) {
    process.stdout.write("Cancelled.\n");
    return;
  }
  if (error instanceof NonInteractiveInputError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
