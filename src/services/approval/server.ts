import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import type { ApprovedPlanSnapshot, TestRunState } from "../../domain/index.js";
import { renderApprovalPage } from "./page.js";
import { verifyAndRecordDecision, type DecisionFailure } from "./decision.js";

/**
 * The local approval review server.
 *
 * Security posture, all enforced here rather than assumed:
 * - binds 127.0.0.1 only, on an OS-assigned free port;
 * - the page lives behind a single-use, unguessable review token in the
 *   path, compared in constant time;
 * - writes additionally require a distinct CSRF token in a custom header
 *   (which a cross-site form post cannot set) and an Origin that matches
 *   the loopback address the page was served from;
 * - one decision per server: a replayed or second submission is refused;
 * - a strict CSP with per-render nonces, no remote assets, no analytics,
 *   no cookies, and no storage;
 * - the server closes itself as soon as a decision is recorded, and on a
 *   timeout if nobody decides.
 *
 * It records a decision. It never executes anything.
 */

export type ApprovalServerOptions = {
  run: TestRunState;
  reviewer: string;
  /** Hard stop for an abandoned review; default 30 minutes. */
  timeoutMs?: number;
};

export type ApprovalServerHandle = {
  url: string;
  port: number;
  /** Resolves with the recorded decision, or undefined if the review timed out or was closed. */
  decision: Promise<ApprovedPlanSnapshot | undefined>;
  close: () => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export async function startApprovalServer(options: ApprovalServerOptions): Promise<ApprovalServerHandle> {
  const reviewToken = randomBytes(24).toString("hex");
  const csrfToken = randomBytes(24).toString("hex");
  const nonce = randomBytes(16).toString("base64");
  const reviewPath = `/review/${reviewToken}`;
  const postPath = `${reviewPath}/decision`;

  let settled = false;
  let resolveDecision: (value: ApprovedPlanSnapshot | undefined) => void = () => undefined;
  const decision = new Promise<ApprovedPlanSnapshot | undefined>((resolve) => {
    resolveDecision = resolve;
  });

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? "/";
    const origin = `http://127.0.0.1:${port()}`;

    if (request.method === "GET" && constantTimeEquals(url, reviewPath)) {
      if (settled) {
        send(response, 410, "text/plain; charset=utf-8", "This review has already been decided.");
        return;
      }
      const body = renderApprovalPage({ run: options.run, csrfToken, nonce, postPath });
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": [
          "default-src 'none'",
          `style-src 'nonce-${nonce}'`,
          `script-src 'nonce-${nonce}'`,
          "connect-src 'self'",
          "form-action 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }

    if (request.method === "POST" && constantTimeEquals(url, postPath)) {
      if (settled) {
        sendJson(response, 409, { code: "already_decided", message: "A decision was already recorded." });
        return;
      }
      // A cross-site page cannot set a custom header on a simple request,
      // and cannot read this token; both checks must pass.
      if (!constantTimeEquals(headerOf(request, "x-nova-csrf"), csrfToken)) {
        sendJson(response, 403, { code: "csrf_failed", message: "Missing or invalid CSRF token." });
        return;
      }
      const requestOrigin = headerOf(request, "origin");
      if (requestOrigin && requestOrigin !== origin) {
        sendJson(response, 403, {
          code: "origin_failed",
          message: "Request origin is not this review page.",
        });
        return;
      }
      if (!headerOf(request, "content-type").startsWith("application/json")) {
        sendJson(response, 415, { code: "invalid_payload", message: "Expected application/json." });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(request));
      } catch {
        sendJson(response, 400, { code: "invalid_payload", message: "Body was not valid JSON." });
        return;
      }

      const result = verifyAndRecordDecision({
        run: options.run,
        payload,
        reviewer: options.reviewer,
        expected: {
          target: options.run.targetManifest.baseUrl,
          environment: options.run.targetManifest.environment,
          scopeDomains: options.run.targetManifest.allowedDomains,
        },
      });
      if (!result.ok) {
        sendJson(response, statusFor(result.failure), result.failure);
        return;
      }

      settled = true;
      sendJson(response, 200, { approvalId: result.snapshot.approvalId, decision: result.snapshot.decision });
      resolveDecision(result.snapshot);
      // Give the response a moment to flush before tearing the socket down.
      setTimeout(() => void close(), 250);
      return;
    }

    send(response, 404, "text/plain; charset=utf-8", "Not found.");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback only. Never 0.0.0.0, never a named host.
    server.listen(0, "127.0.0.1", resolve);
  });

  function port(): number {
    return (server.address() as AddressInfo).port;
  }

  const timer = setTimeout(() => {
    if (!settled) {
      resolveDecision(undefined);
      void close();
    }
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  async function close(): Promise<void> {
    clearTimeout(timer);
    if (!settled) {
      resolveDecision(undefined);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { url: `http://127.0.0.1:${port()}${reviewPath}`, port: port(), decision, close };
}

function statusFor(failure: DecisionFailure): number {
  switch (failure.code) {
    case "already_decided":
      return 409;
    case "stale_plan":
      return 409;
    case "invalid_payload":
    case "unknown_case":
    case "no_selection":
      return 400;
    default:
      return 422;
  }
}

function headerOf(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Length-safe constant-time comparison, so a wrong token leaks nothing through timing. */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}
