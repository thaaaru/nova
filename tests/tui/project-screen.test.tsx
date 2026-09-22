import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

import { buildRuntime, type NovaRuntime } from "../../src/cli/context.js";
import { ProjectScreen } from "../../src/tui/screens/ProjectScreen.js";
import { createProject, listMapsInProject, listProjects } from "../../src/services/testmap/project-service.js";
import { sampleApplicationTestMap } from "../../fixtures/sample-application-test-map.js";

let tempDir: string;
let runtime: NovaRuntime;

function saveAppInProject(target: NovaRuntime, projectId: string, applicationName: string) {
  const map = {
    ...sampleApplicationTestMap,
    id: `${sampleApplicationTestMap.id}-${projectId}`,
    applicationName,
    projectId,
  };
  target.testMaps.save(map);
  return map;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-project-screen-test-"));
  runtime = buildRuntime({
    databasePath: join(tempDir, "nova.sqlite"),
    artifactsDirectory: join(tempDir, "artifacts"),
    headless: true,
  });
});

afterEach(() => {
  runtime.repository.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function settle(ms = 50): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

describe("ProjectScreen", () => {
  it("creates a new project inline and lands directly on its (empty) applications list", async () => {
    const { stdin, lastFrame } = render(
      <ProjectScreen runtime={runtime} onSelectApp={() => {}} onCreateApp={() => {}} onBack={() => {}} />,
    );

    // With no projects yet, the list is just "+ New project".
    await settle();
    stdin.write("\r");
    await settle();
    expect(lastFrame() ?? "").toContain("NEW PROJECT");

    stdin.write("Checkout Squad");
    await settle();
    stdin.write("\r");
    await settle();

    expect(lastFrame() ?? "").toContain("CHECKOUT SQUAD");
    expect(lastFrame() ?? "").toContain("No applications in this project yet.");
    expect(listProjects(runtime).map((project) => project.name)).toEqual(["Checkout Squad"]);
  });

  it("calls onCreateApp with the selected project's id when '+ New app' is chosen", async () => {
    const project = createProject(runtime, { name: "Checkout Squad" });
    const onCreateApp = vi.fn();
    const { stdin } = render(
      <ProjectScreen runtime={runtime} onSelectApp={() => {}} onCreateApp={onCreateApp} onBack={() => {}} />,
    );

    await settle();
    stdin.write("\r"); // select the only project
    await settle();
    stdin.write("\r"); // select "+ New app" (only item in an empty project)
    await settle();

    expect(onCreateApp).toHaveBeenCalledWith(project.id);
  });

  it("calls onSelectApp with an existing app's map id when chosen from the project's app list", async () => {
    const project = createProject(runtime, { name: "Checkout Squad" });
    const map = saveAppInProject(runtime, project.id, "Existing App");

    const onSelectApp = vi.fn();
    const { stdin } = render(
      <ProjectScreen runtime={runtime} onSelectApp={onSelectApp} onCreateApp={() => {}} onBack={() => {}} />,
    );

    await settle();
    stdin.write("\r"); // select the only project
    await settle();
    stdin.write("\r"); // select the only app (listed above "+ New app")
    await settle();

    expect(onSelectApp).toHaveBeenCalledWith(map.id);
  });

  it("deletes a project and every application inside it", async () => {
    const project = createProject(runtime, { name: "Checkout Squad" });
    saveAppInProject(runtime, project.id, "Existing App");
    expect(listMapsInProject(runtime, project.id)).toHaveLength(1);

    const { stdin, lastFrame } = render(
      <ProjectScreen runtime={runtime} onSelectApp={() => {}} onCreateApp={() => {}} onBack={() => {}} />,
    );

    await settle();
    stdin.write("\u001B[B"); // move down to "+ New project"
    await settle();
    stdin.write("\u001B[B"); // move down to "Delete a project"
    await settle();
    stdin.write("\r");
    await settle();
    expect(lastFrame() ?? "").toContain("Which project?");
    stdin.write("\r"); // select the only project
    await settle();
    expect(lastFrame() ?? "").toContain("DELETE PROJECT");
    stdin.write("\r"); // confirm "Yes, delete it"
    await settle();

    expect(listProjects(runtime)).toHaveLength(0);
    expect(listMapsInProject(runtime, project.id)).toHaveLength(0);
  });
});
