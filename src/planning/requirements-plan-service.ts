import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import {
  ArtifactSchema,
  type AppSnapshot,
  type Artifact,
  type ArtifactType,
  type RequirementsTestPlan,
} from "../domain.js";
import { ProjectRepository } from "../storage/project-repository.js";
import {
  DeterministicRequirementsPlanGenerator,
  type RequirementsPlanGenerator,
} from "./requirements-plan-generator.js";

const GENERATABLE_ARTIFACT_TYPES = new Set<ArtifactType>([
  "requirements",
  "test-spec",
  "use-case",
  "api-spec",
]);

export type GenerateRequirementsPlanInput = {
  projectId: string;
  artifactIds?: string[];
  runId?: string;
  snapshot?: AppSnapshot;
  title?: string;
};

export type GeneratedRequirementsPlan = {
  artifact: Artifact;
  plan: RequirementsTestPlan;
};

export class RequirementsPlanService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly workspacePath: string,
    private readonly generator: RequirementsPlanGenerator = new DeterministicRequirementsPlanGenerator(),
  ) {}

  async generate(input: GenerateRequirementsPlanInput): Promise<GeneratedRequirementsPlan> {
    const startedAt = Date.now();
    try {
      const project = this.repository.getProject(input.projectId);
      const artifacts = this.loadArtifacts(project.id, input.artifactIds);
      const plan = await this.generator.generate({
        project,
        artifacts,
        runId: input.runId,
        snapshot: input.snapshot,
      });
      const now = new Date().toISOString();
      const artifactId = randomUUID();
      const artifact = ArtifactSchema.parse({
        id: artifactId,
        projectId: project.id,
        type: "generated-test-plan",
        title: input.title ?? "Generated requirements test plan",
        filePath: `projects/${project.id}/artifacts/${artifactId}-generated-requirements-test-plan.md`,
        createdAt: now,
        updatedAt: now,
      });
      const outputPath = this.resolveArtifactPath(project.id, artifact.filePath);
      const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;

      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(temporaryPath, renderRequirementsPlan(artifact, plan));
      renameSync(temporaryPath, outputPath);
      let createdArtifact: Artifact;
      try {
        createdArtifact = this.repository.createArtifact(artifact);
      } catch (error) {
        unlinkSync(outputPath);
        throw error;
      }

      this.repository.appendEvent(
        input.projectId,
        "requirements_plan_generated",
        {
          runId: input.runId,
          artifactIds: plan.artifactIds,
          generatedArtifactId: createdArtifact.id,
          caseCount: plan.cases.length,
          gapCount: plan.gaps.length,
          coverage: countCoverage(plan.cases),
          durationMs: Date.now() - startedAt,
        },
        now,
      );

      return { artifact: createdArtifact, plan };
    } catch (error) {
      this.repository.appendEvent(
        input.projectId,
        "requirements_plan_generation_failed",
        {
          runId: input.runId,
          artifactIds: input.artifactIds,
          message: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        },
        new Date().toISOString(),
      );
      throw error;
    }
  }

  private loadArtifacts(
    projectId: string,
    artifactIds?: string[],
  ): Array<{ artifact: Artifact; markdown: string }> {
    const artifacts = artifactIds
      ? artifactIds.map((artifactId) => this.repository.getArtifact(artifactId))
      : this.repository
          .listArtifacts(projectId)
          .filter((artifact) => GENERATABLE_ARTIFACT_TYPES.has(artifact.type));
    if (artifacts.length === 0) {
      throw new Error("No requirements, test-spec, use-case, or api-spec artifacts were selected.");
    }

    return artifacts.map((artifact) => {
      if (artifact.projectId !== projectId) {
        throw new Error(`Artifact does not belong to project: ${artifact.id}`);
      }
      if (!GENERATABLE_ARTIFACT_TYPES.has(artifact.type)) {
        throw new Error(`Artifact type cannot be used for generation: ${artifact.type}`);
      }

      const filePath = this.resolveArtifactPath(projectId, artifact.filePath);
      let markdown: string;
      try {
        markdown = readFileSync(filePath, "utf8");
      } catch {
        throw new Error(`Artifact file not found: ${filePath}`);
      }
      if (!markdown.trim()) {
        throw new Error(`Artifact file is empty: ${filePath}`);
      }
      return { artifact, markdown };
    });
  }

  private resolveArtifactPath(projectId: string, filePath: string): string {
    const artifactsDirectory = resolve(this.workspacePath, "projects", projectId, "artifacts");
    const resolvedPath = resolve(this.workspacePath, filePath);
    if (relative(artifactsDirectory, resolvedPath).startsWith("..")) {
      throw new Error(`Artifact file path escapes the project artifact directory: ${filePath}`);
    }
    return resolvedPath;
  }
}

function countCoverage(cases: RequirementsTestPlan["cases"]): Record<string, number> {
  const counts: Record<string, number> = { mapped: 0, partial: 0, unmapped: 0, "not-applicable": 0 };
  for (const testCase of cases) {
    counts[testCase.coverage.status] += 1;
  }
  return counts;
}

function renderRequirementsPlan(artifact: Artifact, plan: RequirementsTestPlan): string {
  const cases = plan.cases
    .map(
      (testCase) =>
        `## ${testCase.title}\n\n` +
        `- Risk: ${testCase.risk}\n` +
        `- Requires approval: ${testCase.requiresApproval}\n` +
        `- Coverage: ${testCase.coverage.status}\n` +
        `- Sources: ${testCase.sources.map((source) => `${source.artifactId} (${source.section})`).join(", ")}\n\n` +
        `### Objective\n\n${testCase.objective}\n\n` +
        `### Steps\n\n${testCase.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n` +
        `### Expected result\n\n${testCase.expectedResult}`,
    )
    .join("\n\n");
  return [
    "---",
    `title: ${JSON.stringify(artifact.title)}`,
    `type: ${artifact.type}`,
    `createdAt: ${artifact.createdAt}`,
    `updatedAt: ${artifact.updatedAt}`,
    "---",
    "",
    "# Generated requirements test plan",
    "",
    plan.summary,
    "",
    `Project: ${plan.projectId}`,
    `Run: ${plan.runId ?? "not supplied"}`,
    `Source artifacts: ${plan.artifactIds.join(", ")}`,
    "",
    cases,
    "",
    "# Gaps",
    "",
    plan.gaps.length > 0 ? plan.gaps.map((gap) => `- ${gap}`).join("\n") : "- None identified.",
    "",
    "# Warnings",
    "",
    plan.warnings.map((warning) => `- ${warning}`).join("\n"),
    "",
  ].join("\n");
}
