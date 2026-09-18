import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { runLighthouseAudit } from "../src/lighthouse/lighthouse-audit.js";

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("runLighthouseAudit", () => {
  it("returns category scores and findings for a real page", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><html><head><title>Fixture</title></head><body><h1>Welcome</h1></body></html>",
      );
    });

    try {
      await listen(server);
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/`;

      const result = await runLighthouseAudit(url);

      expect(result).toBeDefined();
      expect(result?.url).toBe(url);
      expect(result?.categories.length).toBeGreaterThan(0);
      expect(result?.categories.every((category) => category.score === null || category.score >= 0)).toBe(
        true,
      );
    } finally {
      await close(server);
    }
  }, 60_000);

  it("returns undefined rather than throwing when the target is unreachable", async () => {
    const result = await runLighthouseAudit("http://127.0.0.1:1/");
    expect(result).toBeUndefined();
  }, 30_000);
});
