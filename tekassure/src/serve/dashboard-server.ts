import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";

import type { BrandConfig } from "../brand.js";
import { runArtifactsDirectory } from "../artifacts.js";
import { detectLanAddress, isLoopbackHost } from "../network.js";
import { writeReportFiles } from "../reporting/report.js";
import { KnowledgeRepository } from "../storage/knowledge-repository.js";
import { ProjectRepository } from "../storage/project-repository.js";
import { RunRepository } from "../storage/run-repository.js";
import { HarnessWorkflow } from "../workflow/harness-workflow.js";
import { PlaywrightAppDiscoverer } from "../discovery/playwright-app-discoverer.js";
import {
  renderHomePage,
  renderLoginPage,
  renderLoginPendingPage,
  renderLoginSavedPage,
  renderRunPage,
} from "./dashboard-html.js";

export type DashboardServerOptions = {
  databasePath: string;
  knowledgeDatabasePath: string;
  artifactsDirectory: string;
  brand: BrandConfig;
  port?: number;
  /** Bind address for the dashboard. Defaults to 127.0.0.1 (loopback-only). */
  host?: string;
  onStatus: (message: string) => void;
};

export type DashboardServer = {
  url: string;
  close: () => Promise<void>;
};

type PendingLogin = { browser: Browser; context: BrowserContext };

/**
 * Starts a persistent local dashboard: lists runs, starts new discovery runs,
 * reviews/approves/executes any pending run, and serves reports. Defaults to
 * 127.0.0.1 (loopback-only, no authentication on any of it); pass `host` to
 * bind elsewhere (e.g. for LAN access), which the caller must only do on a
 * trusted network. Login capture is triggered from the browser, but always
 * opens a real, separate headed browser window; Nova never handles
 * credentials.
 */
export async function startDashboardServer(options: DashboardServerOptions): Promise<DashboardServer> {
  const { databasePath, knowledgeDatabasePath, artifactsDirectory, brand, onStatus } = options;
  const host = options.host ?? "127.0.0.1";

  const repository = new RunRepository(databasePath);
  const projectRepository = new ProjectRepository(databasePath);
  const knowledgeRepository = new KnowledgeRepository(knowledgeDatabasePath);
  const workflow = new HarnessWorkflow({
    repository,
    discoverer: new PlaywrightAppDiscoverer(),
    knowledgeRepository,
  });

  let pendingLogin: PendingLogin | undefined;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      onStatus(`Error handling ${request.method} ${request.url}: ${String(error)}`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }
      response.end(String(error instanceof Error ? error.message : error));
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/") {
      respondHtml(response, renderHomePage(repository.listRuns(), projectRepository.listProjects(), brand));
      return;
    }

    if (request.method === "POST" && url.pathname === "/runs") {
      const body = await readFormBody(request);
      const result = await workflow.start({
        targetUrl: body.targetUrl,
        goal: body.goal || undefined,
        projectId: body.projectId || undefined,
        artifactsDirectory,
        storageStatePath: body.storageStatePath ? resolve(body.storageStatePath) : undefined,
        allowInteractions: body.allowInteractions === "true",
        policy: {
          allowedOrigins: [],
          maxPages: body.maxPages ? Number.parseInt(body.maxPages, 10) : undefined,
          allowInsecureHttp: body.allowInsecureHttp === "true",
        },
      });
      onStatus(`Started run ${result.runId} for ${body.targetUrl}.`);
      redirect(response, `/runs/${result.runId}`);
      return;
    }

    const runMatch = url.pathname.match(/^\/runs\/([^/]+)(?:\/(.*))?$/);
    if (runMatch) {
      const runId = runMatch[1]!;
      const action = runMatch[2] ?? "";
      await handleRunRequest(request, response, runId, action);
      return;
    }

    if (request.method === "GET" && url.pathname === "/login") {
      respondHtml(response, renderLoginPage(brand));
      return;
    }

    if (request.method === "POST" && url.pathname === "/login") {
      const body = await readFormBody(request);
      if (pendingLogin) {
        respondHtml(response, renderLoginPage(brand, "A login is already in progress. Cancel it first."));
        return;
      }

      const browser = await chromium.launch({ headless: false });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(body.url);
      pendingLogin = { browser, context };
      onStatus(`Opened a browser to log in at ${body.url}.`);
      respondHtml(response, renderLoginPendingPage(brand, body.outputPath));
      return;
    }

    if (request.method === "POST" && url.pathname === "/login/confirm") {
      const body = await readFormBody(request);
      if (!pendingLogin) {
        respondHtml(response, renderLoginPage(brand, "No login is in progress."));
        return;
      }

      const outputPath = resolve(body.outputPath);
      mkdirSync(dirname(outputPath), { recursive: true });
      await pendingLogin.context.storageState({ path: outputPath });
      await pendingLogin.browser.close();
      pendingLogin = undefined;
      onStatus(`Saved storage state to ${outputPath}.`);
      respondHtml(response, renderLoginSavedPage(brand, outputPath));
      return;
    }

    if (request.method === "POST" && url.pathname === "/login/cancel") {
      if (pendingLogin) {
        await pendingLogin.browser.close();
        pendingLogin = undefined;
      }
      redirect(response, "/login");
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  }

  async function handleRunRequest(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
    action: string,
  ): Promise<void> {
    if (request.method === "GET" && action === "") {
      respondHtml(response, renderRunPage(workflow.getResult(runId), workflow.getRun(runId), brand));
      return;
    }

    if (request.method === "POST" && (action === "approve" || action === "reject")) {
      const body = await readFormBody(request);
      const approver = body.approver || "Dashboard reviewer";
      if (action === "approve") {
        await workflow.approve(runId, approver);
      } else {
        await workflow.reject(runId, approver);
      }
      redirect(response, `/runs/${runId}`);
      return;
    }

    if (request.method === "GET" && action === "execute-stream") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event: string, data: unknown): void => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      onStatus(`Running checks for ${runId}…`);
      const result = await workflow.execute(runId, {
        onCheckStart: (page) => send("check-start", { url: page.url }),
        onCheckComplete: (check) =>
          send("check-complete", { url: check.url, status: check.status, error: check.error }),
      });
      await writeReportFiles(result, brand, runArtifactsDirectory(artifactsDirectory, runId));

      const passed = result.execution?.checks.filter((check) => check.status === "passed").length ?? 0;
      const total = result.execution?.checks.length ?? 0;
      onStatus(`${runId}: ${passed} of ${total} check(s) passed.`);
      send("done", { passed, total, status: result.status });
      response.end();
      return;
    }

    if (request.method === "GET" && (action === "report.html" || action === "report.pdf")) {
      const outputDir = runArtifactsDirectory(artifactsDirectory, runId);
      const written = await writeReportFiles(workflow.getResult(runId), brand, outputDir);
      const path = action === "report.html" ? written.htmlPath : written.pdfPath;
      response.writeHead(200, {
        "content-type": action === "report.html" ? "text/html; charset=utf-8" : "application/pdf",
      });
      response.end(readFileSync(path));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port ?? 0, host, () => resolvePromise());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine the dashboard server's port.");
  }
  const displayHost = host === "0.0.0.0" ? (detectLanAddress() ?? host) : host;
  const url = `http://${displayHost}:${address.port}/`;
  if (!isLoopbackHost(host)) {
    onStatus(
      "WARNING: the dashboard is reachable from your network, unauthenticated — " +
        "anyone who can reach it can start/approve/execute scans. Use only on a trusted network.",
    );
  }

  return {
    url,
    close: async () => {
      if (pendingLogin) {
        await pendingLogin.browser.close();
      }
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      workflow.close();
      repository.close();
      projectRepository.close();
      knowledgeRepository.close();
    },
  };
}

function respondHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location });
  response.end();
}

async function readFormBody(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(raw);
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}
