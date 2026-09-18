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
