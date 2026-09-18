#!/usr/bin/env node
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Command } from "commander";

import { buildRuntime } from "./context.js";
import { loadConfig } from "../config/index.js";
import { runApprove, runDiscover, runExecution, runPlan, runReport } from "./commands.js";
import { serveMcp } from "../mcp/server.js";
import { runTui } from "../tui/index.js";
import type { ApplicationTestMapEnvironment, UserJourney, VerificationResult } from "../domain/index.js";
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

/** Commander's recipe for a repeatable option (e.g. `--fixture a --fixture b`). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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

program
  .command("discover")
  .description("Crawl a target and capture a read-only application map.")
  .requiredOption("--target <url>", "Target application URL")
  .option("--manifest <path>", "Path to an approved TargetManifest JSON file")
  .option("--no-headless", "Run the browser headed")
  .action(async (options: { target: string; manifest?: string; headless: boolean }) => {
    const runtime = buildRuntime();
    try {
      const result = await runDiscover(runtime, {
        target: options.target,
        manifest: options.manifest,
        headless: options.headless,
      });
      process.stdout.write(`Run ${result.runId}: discovered ${result.pageCount} page(s).\n`);
      process.stdout.write(`Next: nova plan --objective "<your objective>" --run ${result.runId}\n`);
    } finally {
      runtime.repository.close();
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

program
  .command("report")
  .description("(Re)generate JSON, JUnit, Markdown, and self-contained HTML reports for a run.")
  .requiredOption("--run <runId>", "Run id")
  .action((options: { run: string }) => {
    const runtime = buildRuntime();
    try {
      const written = runReport(runtime, options);
      process.stdout.write(`JSON:     ${written.jsonPath}\n`);
      process.stdout.write(`JUnit:    ${written.junitPath}\n`);
      process.stdout.write(`Markdown: ${written.markdownPath}\n`);
      process.stdout.write(`HTML:     ${written.htmlPath}\n`);
    } finally {
      runtime.repository.close();
    }
  });

const mapCommand = program.command("map").description("Manage Application Test Maps.");

mapCommand
  .command("discover")
  .description("Crawl a target and draft a new Application Test Map (draft until its journeys are approved).")
  .requiredOption("--target <url>", "Target application URL")
  .requiredOption("--name <applicationName>", "Name for the new map's application")
  .requiredOption("--env <environment>", "local|development|staging|production")
  .option("--no-headless", "Run the browser headed")
  .action(
    async (options: {
      target: string;
      name: string;
      env: ApplicationTestMapEnvironment;
      headless: boolean;
    }) => {
      const runtime = buildRuntime();
      try {
        const result = await discoverMap(runtime, {
          target: options.target,
          applicationName: options.name,
          environment: options.env,
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
    } finally {
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

journeyCommand
  .command("approve <journeyId>")
  .description("Approve a journey so it becomes runnable.")
  .requiredOption("--map <mapId>", "Application Test Map id")
  .action((journeyId: string, options: { map: string }) => {
    const runtime = buildRuntime();
    try {
      const journey = approveJourney(runtime, options.map, journeyId);
      process.stdout.write(`Journey ${journey.id} is now "${journey.status}".\n`);
    } finally {
      runtime.repository.close();
    }
  });

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
journeyCommand
  .command("run <journeyId>")
  .description(
    "Run a journey. quick_test executes immediately; guided_test/controlled_test stage for confirmation.",
  )
  .requiredOption("--map <mapId>", "Application Test Map id")
  .requiredOption("--env <environment>", "Environment to run against")
  .option("--persona <personaId>", "Persona id to run as")
  .option("--fixture <fixtureId>", "Fixture id required by the journey (repeatable)", collect, [] as string[])
  .action(
    async (journeyId: string, options: { map: string; env: string; persona?: string; fixture: string[] }) => {
      const runtime = buildRuntime();
      try {
        const prepared = await runJourney(runtime, {
          mapId: options.map,
          journeyId,
          environment: options.env,
          personaId: options.persona,
          fixtureIds: options.fixture,
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

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
