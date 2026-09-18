import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectRepository } from "../src/storage/project-repository.js";

describe("ProjectRepository", () => {
  const resources: Array<{ repository: ProjectRepository; directory: string }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      resource.repository.close();
      await rm(resource.directory, { recursive: true, force: true });
    }
  });

  it("persists projects and Markdown artifact metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-project-repository-"));
    const databasePath = join(directory, "harness.sqlite");
    const repository = new ProjectRepository(databasePath);
    resources.push({ repository, directory });
    const projectId = "00000000-0000-4000-8000-000000000001";
    const artifactId = "00000000-0000-4000-8000-000000000002";
    const createdAt = "2026-09-16T00:00:00.000Z";
    const filePath = join(directory, "projects", projectId, "artifacts", `${artifactId}-dsrs-v1-2.md`);

    const project = repository.createProject({
      id: projectId,
      name: "TekLab website",
      targetUrl: "https://teklab.dev",
      createdAt,
    });
    await mkdir(join(directory, "projects", projectId, "artifacts"), { recursive: true });
    await writeFile(
      filePath,
      `---\ntitle: "DSRS v1.2"\ntype: requirements\ncreatedAt: ${createdAt}\nupdatedAt: ${createdAt}\n---\n\n# DSRS\n`,
    );
    const artifact = repository.createArtifact({
      id: artifactId,
      projectId,
      type: "requirements",
      title: "DSRS v1.2",
      filePath,
      createdAt,
      updatedAt: createdAt,
    });

    expect(project).toMatchObject({ id: projectId, targetUrl: "https://teklab.dev" });
    expect(repository.listProjects()).toEqual([project]);
    expect(repository.listArtifacts(projectId)).toEqual([artifact]);
    expect(repository.listArtifacts(projectId, "requirements")).toEqual([artifact]);
    expect(repository.listArtifacts(projectId, "api-spec")).toEqual([]);
    expect((await stat(filePath)).isFile()).toBe(true);
    await expect(readFile(filePath, "utf8")).resolves.toContain('title: "DSRS v1.2"');

    const database = new Database(databasePath, { readonly: true });
    try {
      expect(database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId)).toMatchObject({
        id: projectId,
        target_url: "https://teklab.dev",
      });
      expect(database.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId)).toMatchObject({
        id: artifactId,
        project_id: projectId,
        type: "requirements",
        file_path: filePath,
      });
    } finally {
      database.close();
    }
  });

  it("fails clearly for an unknown project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-project-repository-"));
    const repository = new ProjectRepository(join(directory, "harness.sqlite"));
    resources.push({ repository, directory });

    expect(() => repository.getProject("00000000-0000-4000-8000-000000000099")).toThrow(
      "Project not found: 00000000-0000-4000-8000-000000000099",
    );
  });
});
