import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PlaywrightAppDiscoverer } from "../src/discovery/playwright-app-discoverer.js";

type TestServer = {
  server: Server;
  baseUrl: string;
};

describe("PlaywrightAppDiscoverer", () => {
  const directories: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("collects safe same-origin evidence without visiting destructive or external links", async () => {
    const target = await startTestServer();
    servers.push(target.server);
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "harness-discovery-"));
    directories.push(artifactsDirectory);

    const snapshot = await new PlaywrightAppDiscoverer().discover({
      runId: "11111111-1111-4111-8111-111111111111",
      targetUrl: target.baseUrl,
      artifactsDirectory,
      policy: {
        allowedOrigins: [],
        maxPages: 5,
        maxControlsPerPage: 20,
        maxLinksPerPage: 20,
        allowInsecureHttp: true,
      },
    });

    expect(snapshot.pages.map((page) => page.path)).toEqual(["/", "/orders"]);
    expect(snapshot.pages[0]?.controls.some((control) => control.label === "Search orders")).toBe(true);
    expect(snapshot.pages.flatMap((page) => page.links)).not.toContain(`${target.baseUrl}/logout`);
    expect(snapshot.pages.flatMap((page) => page.links)).not.toContain("https://outside.example.test/");
    const discoveryDirectory = join(artifactsDirectory, "11111111-1111-4111-8111-111111111111", "discovery");
    for (const page of snapshot.pages) {
      expect(page.screenshotPath?.startsWith(discoveryDirectory)).toBe(true);
    }
    expect((await stat(snapshot.pages[0]!.screenshotPath!)).isFile()).toBe(true);
  });

  it("reaches session-gated content when given a pre-authenticated storage state", async () => {
    const target = await startAuthGatedServer();
    servers.push(target.server);
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "harness-discovery-auth-"));
    directories.push(artifactsDirectory);
    const storageStatePath = join(artifactsDirectory, "storage-state.json");
    await writeFile(
      storageStatePath,
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: "authenticated",
            domain: "127.0.0.1",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    );

    const anonymousSnapshot = await new PlaywrightAppDiscoverer().discover({
      runId: "22222222-2222-4222-8222-222222222222",
      targetUrl: target.baseUrl,
      artifactsDirectory,
      policy: {
        allowedOrigins: [],
        maxPages: 5,
        maxControlsPerPage: 20,
        maxLinksPerPage: 20,
        allowInsecureHttp: true,
      },
    });
    expect(anonymousSnapshot.pages[0]?.title).toBe("Please sign in");

    const authenticatedSnapshot = await new PlaywrightAppDiscoverer().discover({
      runId: "33333333-3333-4333-8333-333333333333",
      targetUrl: target.baseUrl,
      artifactsDirectory,
      storageStatePath,
      policy: {
        allowedOrigins: [],
        maxPages: 5,
        maxControlsPerPage: 20,
        maxLinksPerPage: 20,
        allowInsecureHttp: true,
      },
    });
    expect(authenticatedSnapshot.pages[0]?.title).toBe("Account dashboard");
    expect(authenticatedSnapshot.pages[0]?.headings).toContain("Welcome back");
  });
});

async function startTestServer(): Promise<TestServer> {
  const server = createServer((request, response) => {
    const route = request.url ?? "/";
    response.setHeader("content-type", "text/html; charset=utf-8");

    if (route === "/orders") {
      response.end(`<!doctype html>
        <html><head><title>Orders</title></head>
        <body><h1>Orders</h1><button type="button">New draft</button></body></html>`);
      return;
    }

    response.end(`<!doctype html>
      <html><head><title>Harness fixture</title></head>
      <body>
        <h1>Welcome</h1>
        <label>Search orders <input type="search" name="search" /></label>
        <button type="button">Open filters</button>
        <a href="/orders">Orders</a>
        <a href="/logout">Sign out</a>
        <a href="https://outside.example.test/">External page</a>
      </body></html>`);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The test server did not expose a TCP address.");
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function startAuthGatedServer(): Promise<TestServer> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    const isAuthenticated = (request.headers.cookie ?? "").includes("session=authenticated");

    if (isAuthenticated) {
      response.end(`<!doctype html>
        <html><head><title>Account dashboard</title></head>
        <body><h1>Welcome back</h1></body></html>`);
      return;
    }

    response.end(`<!doctype html>
      <html><head><title>Please sign in</title></head>
      <body><h1>Sign in required</h1></body></html>`);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The test server did not expose a TCP address.");
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}
