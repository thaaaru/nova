import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { buildRuntime } from "../cli/context.js";
import { runApprove, runDiscover, runExecution, runPlan, runReport } from "../cli/commands.js";

/**
 * Nova is the authoritative boundary — the connecting IDE/CLI agent is
 * only an operator interface calling these tools one step at a time. Every
 * tool here is a thin wrapper around the exact same functions the CLI
 * uses; there is no separate "MCP path" through policy, approval, or
 * execution that could diverge from what a human running the CLI gets.
 * The model on the other end of this connection can call discover/plan
 * freely, but approval and execution still require the plan and decision
 * to be well-formed and pass every policy check in code — this server
 * grants it no additional authority over those gates.
 */
function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export async function serveMcp(): Promise<void> {
  const runtime = buildRuntime();
  const server = new McpServer({ name: "nova", version: "0.1.0" });

  server.registerTool(
    "nova_discover",
    {
      title: "Discover application",
      description: "Crawl a target URL and capture a read-only application map.",
      inputSchema: {
        target: z.string().url(),
        manifestPath: z.string().optional(),
      },
    },
    async ({ target, manifestPath }) => {
      const result = await runDiscover(runtime, { target, manifest: manifestPath });
      return textResult(result);
    },
  );

  server.registerTool(
    "nova_plan",
    {
      title: "Generate test plan",
      description: "Generate a reviewable TestPlan from a discovered run and an objective.",
      inputSchema: {
        objective: z.string().min(1),
        runId: z.string().optional(),
      },
    },
    async ({ objective, runId }) => {
      const result = await runPlan(runtime, { objective, run: runId });
      return textResult(result);
    },
  );

  server.registerTool(
    "nova_approve",
    {
      title: "Approve or reject a test plan",
      description: "Record a human approval/rejection decision. No case can execute before this.",
      inputSchema: {
        planId: z.string().min(1),
        reviewer: z.string().optional(),
        reject: z.boolean().optional(),
        note: z.string().optional(),
      },
    },
    async ({ planId, reviewer, reject, note }) => {
      const result = await runApprove(runtime, { plan: planId, reviewer, reject, note });
      return textResult(result);
    },
  );

  server.registerTool(
    "nova_run",
    {
      title: "Execute an approved test plan",
      description: "Run an approved TestPlan's cases, then verify and report. Fails closed if not approved.",
      inputSchema: {
        planId: z.string().min(1),
      },
    },
    async ({ planId }) => {
      const result = await runExecution(runtime, { plan: planId });
      return textResult(result);
    },
  );

  server.registerTool(
    "nova_report",
    {
      title: "Generate run report",
      description: "(Re)generate JSON, JUnit, and Markdown reports for a run, linked to their evidence.",
      inputSchema: {
        runId: z.string().min(1),
      },
    },
    ({ runId }) => {
      const written = runReport(runtime, { run: runId });
      return textResult(written);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
