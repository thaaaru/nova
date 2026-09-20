import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RequirementsPlanService } from "../src/planning/requirements-plan-service.js";
import { ProjectRepository } from "../src/storage/project-repository.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const artifactId = "00000000-0000-4000-8000-000000000002";
const createdAt = "2026-09-16T00:00:00.000Z";

describe("RequirementsPlanService", () => {
  const resources: Array<{ directory: string; repository: ProjectRepository }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      resource.repository.close();
      await rm(resource.directory, { recursive: true, force: true });
    }
  });

  it("reads project artifacts and atomically persists a generated Markdown plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-requirements-plan-"));
    const repository = new ProjectRepository(join(directory, "harness.sqlite"));
    resources.push({ directory, repository });
    repository.createProject({ id: projectId, name: "TekLab", createdAt });
    const sourcePath = `projects/${projectId}/artifacts/${artifactId}-requirements.md`;
    await mkdir(join(directory, "projects", projectId, "artifacts"), { recursive: true });
    await writeFile(join(directory, sourcePath), "# Password reset\nUsers can reset a forgotten password.\n");
    repository.createArtifact({
      id: artifactId,
      projectId,
      type: "requirements",
      title: "DSRS",
      filePath: sourcePath,
      createdAt,
      updatedAt: createdAt,
    });

    const result = await new RequirementsPlanService(repository, directory).generate({ projectId });

    expect(result.artifact).toMatchObject({ projectId, type: "generated-test-plan" });
    expect(repository.getArtifact(result.artifact.id)).toEqual(result.artifact);
    await expect(readFile(join(directory, result.artifact.filePath), "utf8")).resolves.toContain(
      "# Generated requirements test plan",
    );

    const events = repository.listEvents(projectId);
    const generated = events.find((event) => event.type === "requirements_plan_generated");
    expect(generated?.payload).toMatchObject({ generatedArtifactId: result.artifact.id });
    expect((generated?.payload.caseCount as number) >= 1).toBe(true);
    expect((generated?.payload.coverage as Record<string, number>)["not-applicable"]).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("rejects an artifact path outside the project artifact directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-requirements-plan-"));
    const repository = new ProjectRepository(join(directory, "harness.sqlite"));
    resources.push({ directory, repository });
    repository.createProject({ id: projectId, name: "TekLab", createdAt });
    repository.createArtifact({
      id: artifactId,
      projectId,
      type: "requirements",
      title: "DSRS",
      filePath: "outside.md",
      createdAt,
      updatedAt: createdAt,
    });

    await expect(new RequirementsPlanService(repository, directory).generate({ projectId })).rejects.toThrow(
      "Artifact file path escapes the project artifact directory: outside.md",
    );

    const events = repository.listEvents(projectId);
    const failed = events.find((event) => event.type === "requirements_plan_generation_failed");
    expect(failed?.payload.message).toContain("escapes the project artifact directory");
  });
});
