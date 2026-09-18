import { randomUUID } from "node:crypto";

import {
  RequirementsTestPlanSchema,
  type AppSnapshot,
  type Artifact,
  type GeneratedTestCase,
  type Project,
  type RequirementCoverage,
  type RequirementsTestPlan,
  type RiskLevel,
} from "../domain.js";

export type RequirementsPlanRequest = {
  project: Project;
  artifacts: Array<{ artifact: Artifact; markdown: string }>;
  runId?: string;
  snapshot?: AppSnapshot;
};

export interface RequirementsPlanGenerator {
  generate(request: RequirementsPlanRequest): Promise<RequirementsTestPlan>;
}

/**
 * A bounded baseline generator for the artifact-store milestone. It derives
 * review-only cases from Markdown headings and never accesses a browser,
 * repository, network, or credentials.
 */
export class DeterministicRequirementsPlanGenerator implements RequirementsPlanGenerator {
  async generate(request: RequirementsPlanRequest): Promise<RequirementsTestPlan> {
    if (request.artifacts.length === 0) {
      throw new Error("Cannot generate test cases without project artifacts.");
    }

    const cases = request.artifacts.flatMap(({ artifact, markdown }) =>
      this.createCases(artifact, markdown, request.snapshot),
    );
    if (cases.length === 0) {
      throw new Error("Cannot generate test cases from empty project artifacts.");
    }

    const gaps = cases
      .filter((testCase) => testCase.coverage.status === "partial" || testCase.coverage.status === "unmapped")
      .map((testCase) => `${testCase.title}: ${testCase.coverage.rationale}`);

    return RequirementsTestPlanSchema.parse({
      id: randomUUID(),
      projectId: request.project.id,
      runId: request.runId,
      createdAt: new Date().toISOString(),
      artifactIds: request.artifacts.map(({ artifact }) => artifact.id),
      summary: `Generated ${cases.length} reviewable test case(s) from ${request.artifacts.length} project artifact(s).`,
      cases,
      gaps,
      warnings: request.snapshot
        ? ["Discovery mapping is evidence correlation, not product verification."]
        : ["No discovery snapshot was supplied; coverage mapping was not performed."],
    });
  }

  private createCases(artifact: Artifact, markdown: string, snapshot?: AppSnapshot): GeneratedTestCase[] {
    const sections = extractSections(markdown);
    return sections.map(({ title, excerpt }) => {
      const risk = inferRisk(`${title}\n${excerpt}`);
      return {
        id: randomUUID(),
        title: `Verify: ${title}`,
        objective: `Verify the behavior documented in ${title}.`,
        preconditions: [],
        steps: ["Review the documented requirement and verify its expected behavior with approved evidence."],
        expectedResult: `The behavior documented in ${title} satisfies the stated requirement.`,
        risk,
        requiresApproval: risk !== "read_only",
        sources: [{ artifactId: artifact.id, filePath: artifact.filePath, section: title, excerpt }],
        coverage: mapCoverage(`${title}\n${excerpt}`, snapshot),
      };
    });
  }
}

function extractSections(markdown: string): Array<{ title: string; excerpt: string }> {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!body) {
    return [];
  }

  const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => ({
    title: match[1].trim(),
    index: match.index ?? 0,
  }));
  if (headings.length === 0) {
    return [{ title: "Documented requirement", excerpt: body.slice(0, 2_000) }];
  }

  return headings.map((heading, index) => ({
    title: heading.title,
    excerpt: body
      .slice(heading.index, headings[index + 1]?.index)
      .trim()
      .slice(0, 2_000),
  }));
}

function inferRisk(value: string): RiskLevel {
  const normalized = value.toLowerCase();
  if (/\b(log ?in|sign ?in|authenticate|password reset)\b/.test(normalized)) {
    return "session_change";
  }
  if (/\b(create|update|delete|submit|upload|purchase|payment|register)\b/.test(normalized)) {
    return "state_change";
  }
  return "read_only";
}

function mapCoverage(value: string, snapshot?: AppSnapshot): RequirementCoverage {
  if (!snapshot) {
    return {
      status: "not-applicable",
      discoveredPaths: [],
      rationale: "No discovery snapshot was supplied.",
    };
  }

  const terms = significantTerms(value);
  const matches = snapshot.pages.filter((page) => {
    const evidence = `${page.path} ${page.title} ${page.headings.join(" ")} ${page.controls.map((control) => control.label ?? control.name ?? "").join(" ")}`;
    const pageTerms = significantTerms(evidence);
    return [...terms].filter((term) => pageTerms.has(term)).length >= 2;
  });
  if (matches.length > 0) {
    return {
      status: "mapped",
      discoveredPaths: matches.map((page) => page.path),
      rationale: "At least two requirement terms match discovered route evidence.",
    };
  }

  const partial = snapshot.pages.some((page) => {
    const evidence = significantTerms(`${page.path} ${page.title} ${page.headings.join(" ")}`);
    return [...terms].some((term) => evidence.has(term));
  });
  return {
    status: partial ? "partial" : "unmapped",
    discoveredPaths: [],
    rationale: partial
      ? "One requirement term matches discovery evidence, which is insufficient to establish full coverage."
      : "No direct discovery evidence maps to this requirement.",
  };
}

function significantTerms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter(
        (term) =>
          term.length > 3 &&
          !["that", "this", "with", "from", "must", "should", "documented", "requirement"].includes(term),
      ) ?? [],
  );
}
