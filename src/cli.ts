#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import { chromium } from "playwright";

import { ArtifactSchema } from "./domain.js";
import { WEB_APP_BASELINE_PRESET } from "./goal-presets.js";
import { runArtifactsDirectory } from "./artifacts.js";

import { loadBrandConfig } from "./brand.js";
import { PlaywrightAppDiscoverer } from "./discovery/playwright-app-discoverer.js";
import { activateLicense, requireValidLicense } from "./licensing/activate.js";
import { LicenseError } from "./licensing/verify-license.js";
import { RequirementsPlanService } from "./planning/requirements-plan-service.js";
import { writeReportFiles } from "./reporting/report.js";
import { runInteractiveReview } from "./review/review-server.js";
import { openInBrowser } from "./review/browser.js";
import { startDashboardServer } from "./serve/dashboard-server.js";
import { KnowledgeRepository } from "./storage/knowledge-repository.js";
import { ProjectNotFoundError, ProjectRepository } from "./storage/project-repository.js";
import { RunRepository } from "./storage/run-repository.js";
import { HarnessWorkflow, type WorkflowResult } from "./workflow/harness-workflow.js";

// Runs after all imports resolve; none of them read env vars at import time
// (only inside function bodies called below), so loading .env here — quietly,
// since printResult() writes JSON to the same stdout — is safe.
loadDotenv({ quiet: true });

const brand = loadBrandConfig();

const program = new Command();
program
  .name(brand.cliDisplayName)
  .description(`${brand.productName} governed AI-assisted Playwright test automation.`);

program
  .command("license")
  .description("Manage the local Nova license.")
  .command("activate <key>")
  .description("Activate a license key.")
  .action(async (key: string) => {
    await withLicenseErrorHandling(async () => {
      const stored = await activateLicense(key);
      process.stdout.write(
        `License ${stored.payload.licenseId} activated for org ${stored.payload.orgId}.\n`,
      );
    });
  });

program
  .command("discover")
  .description("Discover an application and generate a reviewable test plan without executing it.")
  .requiredOption("--url <url>", "application URL")
  .option("--goal <goal>", "test objective", WEB_APP_BASELINE_PRESET)
  .option("--allow-origin <origin...>", "additional permitted origins", [])
  .option("--max-pages <count>", "maximum routes to inspect", parsePositiveInteger, 10)
  .option("--allow-insecure-http", "permit HTTP for a local or isolated test environment", false)
  .option(
    "--allow-interactions",
    "let the planner propose, and the run execute, safe click/fill/select interactions " +
      "(grounded against discovered controls, denylist-filtered, still human-reviewed before running)",
    false,
  )
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .option("--knowledge-database <path>", "SQLite knowledge-base path", "data/knowledge.sqlite")
  .option("--artifacts <path>", "artifact directory", "artifacts")
  .option("--headless <boolean>", "run Chromium headlessly (true or false)", parseBoolean, true)
  .option("--json", "print raw JSON instead of opening an interactive browser review", false)
  .option("--project <projectId>", "link this run to a project")
  .option("--storage-state <path>", "Playwright storage state file for an authenticated session")
  .option(
    "--host <address>",
    "bind address for the interactive review server; only change this on a trusted network (no authentication)",
    "127.0.0.1",
  )
  .action(async (options) => {
    if (options.project) {
      await withProjectRepository(options.database, async (repository) => {
        repository.getProject(options.project);
      });
    }

    const artifactsDirectory = resolve(options.artifacts);
    await withWorkflow(options.database, options.knowledgeDatabase, async (workflow) => {
      const result = await workflow.start({
        targetUrl: options.url,
        projectId: options.project,
        goal: options.goal,
        artifactsDirectory,
        headless: options.headless,
        storageStatePath: options.storageState ? resolve(options.storageState) : undefined,
        allowInteractions: options.allowInteractions,
        policy: {
          allowedOrigins: options.allowOrigin,
          maxPages: options.maxPages,
          allowInsecureHttp: options.allowInsecureHttp,
        },
      });

      if (options.json || !process.stdout.isTTY) {
        printResult(result);
        if (result.status === "awaiting_approval") {
          printNextSteps([
            `${brand.cliDisplayName} approve ${result.runId} --approver "<your name>"`,
            `${brand.cliDisplayName} execute ${result.runId}`,
          ]);
        }
        return;
      }

      const pageCount = result.snapshot?.pages.length ?? 0;
      process.stdout.write(`Discovered ${pageCount} page(s).\n`);
      if (result.status !== "awaiting_approval") {
        printResult(result);
        return;
      }

      await runInteractiveReview({
        workflow,
        result,
        brand,
        artifactsDirectory,
        host: options.host,
        onStatus: (message) => process.stdout.write(`${message}\n`),
      });
      process.stdout.write("Done.\n");
    });
  });

const project = program.command("project").description("Manage reusable test projects.");

project
  .command("create")
  .description("Create a reusable test project.")
  .requiredOption("--name <name>", "project name")
  .option("--url <url>", "application URL")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .action(async (options) => {
    await withProjectRepository(options.database, async (repository) => {
      printJson(
        repository.createProject({
          id: randomUUID(),
          name: options.name,
          targetUrl: options.url,
          createdAt: new Date().toISOString(),
        }),
      );
    });
  });

project
  .command("list")
  .description("List reusable test projects.")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .action(async (options) => {
    await withProjectRepository(options.database, async (repository) => {
      printJson(repository.listProjects());
    });
  });

project
  .command("show <projectId>")
  .description("Show a reusable test project.")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .action(async (projectId, options) => {
    await withProjectRepository(options.database, async (repository) => {
      printJson(repository.getProject(projectId));
    });
  });

const artifact = program.command("artifact").description("Manage project artifacts.");

artifact
  .command("add <projectId>")
  .description("Add a Markdown artifact to a project.")
  .requiredOption("--type <type>", "artifact type")
  .requiredOption("--title <title>", "artifact title")
  .requiredOption("--file <path>", "Markdown source file")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .action(async (projectId, options) => {
    await withProjectRepository(options.database, async (repository) => {
      repository.getProject(projectId);
      const sourcePath = resolve(options.file);
      let content: string;
      try {
        content = readFileSync(sourcePath, "utf8");
      } catch {
        throw new Error(`Artifact file not found: ${sourcePath}`);
      }

      if (!sourcePath.endsWith(".md")) {
        throw new Error("Artifact file must be a Markdown (.md) file.");
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      const filePath = join("projects", projectId, "artifacts", `${id}-${toSlug(options.title)}.md`);
      const artifact = ArtifactSchema.parse({
        id,
        projectId,
        type: options.type,
        title: options.title,
        filePath,
        createdAt: now,
        updatedAt: now,
      });
      mkdirSync(dirname(resolve(filePath)), { recursive: true });
      writeFileSync(
        resolve(filePath),
        `---\ntitle: ${JSON.stringify(artifact.title)}\ntype: ${artifact.type}\ncreatedAt: ${now}\nupdatedAt: ${now}\n---\n\n${content}`,
      );
      printJson(repository.createArtifact(artifact));
    });
  });

artifact
  .command("list <projectId>")
  .description("List a project's artifacts.")
  .option("--type <type>", "filter by artifact type")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .action(async (projectId, options) => {
    await withProjectRepository(options.database, async (repository) => {
      repository.getProject(projectId);
      printJson(repository.listArtifacts(projectId, options.type));
    });
  });

artifact
  .command("show <artifactId>")
  .description("Show an artifact.")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .action(async (artifactId, options) => {
    await withProjectRepository(options.database, async (repository) => {
      printJson(repository.getArtifact(artifactId));
    });
  });

program
  .command("generate")
  .description("Generate reviewable test cases from project requirement artifacts.")
  .requiredOption("--project <projectId>", "project ID")
  .option("--run <runId>", "map cases to a discovered run")
  .option("--artifact <artifactId...>", "select source artifacts")
  .option("--title <title>", "generated artifact title")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .action(async (options) => {
    await withProjectRepository(options.database, async (repository) => {
      let snapshot;
      if (options.run) {
        const runRepository = new RunRepository(resolve(options.database));
        try {
          const run = runRepository.getRun(options.run);
          if (run.input.projectId !== options.project) {
            throw new Error(`Run does not belong to project: ${options.run}`);
          }
          snapshot = runRepository.getSnapshot(options.run);
          if (!snapshot) {
            throw new Error(`Run has no discovery snapshot: ${options.run}`);
          }
        } finally {
          runRepository.close();
        }
      }

      printJson(
        await new RequirementsPlanService(repository, resolve(".")).generate({
          projectId: options.project,
          artifactIds: options.artifact,
          runId: options.run,
          snapshot,
          title: options.title,
        }),
      );
    });
  });

program
  .command("approve <runId>")
  .description("Approve a persisted test plan. Run the constrained read-only checks separately with execute.")
  .option("--approver <name>", "approval actor", "local-operator")
  .option("--note <note>", "approval note")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .option("--knowledge-database <path>", "SQLite knowledge-base path", "data/knowledge.sqlite")
  .action(async (runId, options) => {
    await withWorkflow(options.database, options.knowledgeDatabase, async (workflow) => {
      const result = await workflow.approve(runId, options.approver, options.note);
      printResult(result);
      if (result.status === "ready_to_execute") {
        printNextSteps([`${brand.cliDisplayName} execute ${result.runId}`]);
      }
    });
  });

program
  .command("reject <runId>")
  .description("Reject a persisted test plan before browser execution.")
  .option("--approver <name>", "approval actor", "local-operator")
  .option("--note <note>", "rejection note")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .option("--knowledge-database <path>", "SQLite knowledge-base path", "data/knowledge.sqlite")
  .action(async (runId, options) => {
    await withWorkflow(options.database, options.knowledgeDatabase, async (workflow) => {
      printResult(await workflow.reject(runId, options.approver, options.note));
    });
  });

program
  .command("execute <runId>")
  .description("Execute the approved plan using only constrained read-only GET navigation and assertions.")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .option("--knowledge-database <path>", "SQLite knowledge-base path", "data/knowledge.sqlite")
  .option(
    "--headless <boolean>",
    "override the run's Chromium headless setting (true or false)",
    parseBoolean,
  )
  .action(async (runId, options) => {
    await withWorkflow(options.database, options.knowledgeDatabase, async (workflow) => {
      const result = await workflow.execute(runId, { headless: options.headless });
      printResult(result);
      if (result.status === "passed" || result.status === "failed") {
        printNextSteps([`${brand.cliDisplayName} report ${result.runId}`]);
      }
    });
  });

program
  .command("install-browser")
  .description(`Install the matching Chromium browser used by ${brand.productName}.`)
  .action(async () => {
    await installChromium();
  });

program
  .command("login")
  .description(
    "Open a headed browser to manually authenticate, then save the session as a storage state file for --storage-state.",
  )
  .requiredOption("--url <url>", "application login URL to open")
  .requiredOption("--save-storage-state <path>", "output path for the captured storage state file")
  .action(async (options) => {
    await requireValidLicense();
    const storageStatePath = resolve(options.saveStorageState);
    await saveAuthenticatedStorageState(options.url, storageStatePath);
    printNextSteps([`${brand.cliDisplayName} discover --url <app-url> --storage-state ${storageStatePath}`]);
  });

program
  .command("status <runId>")
  .description("Show a run, its app snapshot, test plan, and any execution result.")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .option("--knowledge-database <path>", "SQLite knowledge-base path", "data/knowledge.sqlite")
  .action(async (runId, options) => {
    await withWorkflow(options.database, options.knowledgeDatabase, async (workflow) => {
      printResult(workflow.getResult(runId));
    });
  });

program
  .command("report <runId>")
  .description("Generate a branded HTML and PDF report for a run.")
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .option("--knowledge-database <path>", "SQLite knowledge-base path", "data/knowledge.sqlite")
  .option("--output <dir>", "output directory", "")
  .action(async (runId, options) => {
    await withWorkflow(options.database, options.knowledgeDatabase, async (workflow) => {
      const result = workflow.getResult(runId);
      const run = workflow.getRun(runId);
      const outputDir = resolve(options.output || runArtifactsDirectory(run.input.artifactsDirectory, runId));
      const { htmlPath, pdfPath } = await writeReportFiles(result, brand, outputDir);
      process.stdout.write(`${JSON.stringify({ html: htmlPath, pdf: pdfPath }, null, 2)}\n`);
    });
  });

const knowledge = program
  .command("knowledge")
  .description("Browse and search the accumulated knowledge base.");

knowledge
  .command("list")
  .description("List captured knowledge entries, most recent first.")
  .option("--category <category>", "filter by category (domain_knowledge, failure, solution)")
  .option("--target <url>", "filter by target URL")
  .option("--limit <count>", "maximum entries to return", parsePositiveInteger, 50)
  .option("--knowledge-database <path>", "SQLite knowledge-base path", "data/knowledge.sqlite")
  .action(async (options) => {
    await withKnowledgeRepository(options.knowledgeDatabase, async (repository) => {
      printJson(
        repository.list({
          category: options.category,
          targetUrl: options.target,
          limit: options.limit,
        }),
      );
    });
  });

knowledge
  .command("search <query>")
  .description("Search knowledge entries by title, summary, detail, or tag.")
  .option("--limit <count>", "maximum entries to return", parsePositiveInteger, 50)
  .option("--knowledge-database <path>", "SQLite knowledge-base path", "data/knowledge.sqlite")
  .action(async (query, options) => {
    await withKnowledgeRepository(options.knowledgeDatabase, async (repository) => {
      printJson(repository.search(query, options.limit));
    });
  });

knowledge
  .command("show <entryId>")
  .description("Show a single knowledge entry.")
  .option("--knowledge-database <path>", "SQLite knowledge-base path", "data/knowledge.sqlite")
  .action(async (entryId, options) => {
    await withKnowledgeRepository(options.knowledgeDatabase, async (repository) => {
      printJson(repository.getEntry(entryId));
    });
  });

program
  .command("serve")
  .description(
    "Run a persistent local dashboard: start scans, capture logins, and review/approve/execute/report from your browser.",
  )
  .option("--database <path>", "SQLite database path", "data/harness.sqlite")
  .option("--knowledge-database <path>", "SQLite knowledge-base path", "data/knowledge.sqlite")
  .option("--artifacts <path>", "artifact directory", "artifacts")
  .option("--port <port>", "port to listen on (default: pick any free port)", parsePositiveInteger)
  .option(
    "--host <address>",
    "bind address for the dashboard; only change this on a trusted network (no authentication)",
    "127.0.0.1",
  )
  .action(async (options) => {
    await requireValidLicense();
    const dashboard = await startDashboardServer({
      databasePath: resolve(options.database),
      knowledgeDatabasePath: resolve(options.knowledgeDatabase),
      artifactsDirectory: resolve(options.artifacts),
      brand,
      port: options.port,
      host: options.host,
      onStatus: (message) => process.stdout.write(`${message}\n`),
    });

    process.stdout.write(`${brand.productName} dashboard running at ${dashboard.url}\n`);
    process.stdout.write("Press Ctrl+C to stop.\n");
    openInBrowser(dashboard.url);

    await new Promise<void>((resolveShutdown) => {
      process.once("SIGINT", () => resolveShutdown());
      process.once("SIGTERM", () => resolveShutdown());
    });

    process.stdout.write("Shutting down…\n");
    await dashboard.close();
  });

void program.parseAsync().catch((error: unknown) => {
  if (error instanceof LicenseError || error instanceof ProjectNotFoundError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

async function withLicenseErrorHandling(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof LicenseError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function withProjectRepository<T>(
  databasePath: string,
  action: (repository: ProjectRepository) => Promise<T>,
): Promise<T> {
  await requireValidLicense();

  const repository = new ProjectRepository(resolve(databasePath));
  try {
    return await action(repository);
  } finally {
    repository.close();
  }
}

async function withWorkflow<T>(
  databasePath: string,
  knowledgeDatabasePath: string,
  action: (workflow: HarnessWorkflow) => Promise<T>,
): Promise<T> {
  await requireValidLicense();

  const resolvedDatabasePath = resolve(databasePath);
  const repository = new RunRepository(resolvedDatabasePath);
  const knowledgeRepository = new KnowledgeRepository(resolve(knowledgeDatabasePath));
  const workflow = new HarnessWorkflow({
    repository,
    discoverer: new PlaywrightAppDiscoverer(),
    knowledgeRepository,
  });

  try {
    return await action(workflow);
  } finally {
    workflow.close();
    repository.close();
    knowledgeRepository.close();
  }
}

async function withKnowledgeRepository<T>(
  knowledgeDatabasePath: string,
  action: (repository: KnowledgeRepository) => Promise<T>,
): Promise<T> {
  await requireValidLicense();

  const repository = new KnowledgeRepository(resolve(knowledgeDatabasePath));
  try {
    return await action(repository);
  } finally {
    repository.close();
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Expected a positive integer.");
  }
  return parsed;
}

function parseBoolean(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error("Expected true or false.");
}

async function installChromium(): Promise<void> {
  const require = createRequire(import.meta.url);
  const playwrightPackagePath = require.resolve("playwright/package.json");
  const playwrightCliPath = resolve(dirname(playwrightPackagePath), "cli.js");
  const processHandle = spawn(process.execPath, [playwrightCliPath, "install", "chromium"], {
    stdio: "inherit",
  });

  await new Promise<void>((resolveInstall, reject) => {
    processHandle.once("error", reject);
    processHandle.once("exit", (code) => {
      if (code === 0) {
        resolveInstall();
        return;
      }
      reject(new Error(`Chromium installation exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function saveAuthenticatedStorageState(url: string, outputPath: string): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    process.stdout.write(
      "Log in in the opened browser window, then press Enter here once you're signed in.\n",
    );
    await waitForEnter();
    mkdirSync(dirname(outputPath), { recursive: true });
    await context.storageState({ path: outputPath });
    chmodSync(outputPath, 0o600);
    process.stdout.write(`Saved storage state to ${outputPath}\n`);
  } finally {
    await browser.close();
  }
}

async function waitForEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question("");
  } finally {
    rl.close();
  }
}

function printResult(result: WorkflowResult): void {
  printJson(result);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function toSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "artifact"
  );
}

function printNextSteps(commands: string[]): void {
  const label = commands.length > 1 ? "Next steps:" : "Next step:";
  const lines = commands.map((command) => `  ${command}`).join("\n");
  process.stderr.write(`\n${label}\n${lines}\n`);
}
