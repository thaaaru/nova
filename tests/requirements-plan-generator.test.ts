import { describe, expect, it } from "vitest";

import type { AppSnapshot, Artifact, Project } from "../src/domain.js";
import { DeterministicRequirementsPlanGenerator } from "../src/planning/requirements-plan-generator.js";

const project: Project = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "TekLab website",
  createdAt: "2026-09-16T00:00:00.000Z",
};

const artifact: Artifact = {
  id: "00000000-0000-4000-8000-000000000002",
  projectId: project.id,
  type: "requirements",
  title: "DSRS",
  filePath: "projects/00000000-0000-4000-8000-000000000001/artifacts/dsrs.md",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

const snapshot: AppSnapshot = {
  id: "00000000-0000-4000-8000-000000000003",
  targetUrl: "https://teklab.dev",
  discoveredAt: "2026-09-16T00:00:00.000Z",
  warnings: [],
  pages: [
    {
      url: "https://teklab.dev/password-reset",
      path: "/password-reset",
      title: "Password reset",
      headings: ["Password reset"],
      controls: [{ kind: "textbox", label: "Email address", disabled: false }],
      links: [],
      consoleErrors: [],
      pageErrors: [],
      fingerprint: "password-reset",
    },
  ],
};

describe("DeterministicRequirementsPlanGenerator", () => {
  it("creates traceable, approval-gated cases and maps discovery evidence", async () => {
    const plan = await new DeterministicRequirementsPlanGenerator().generate({
      project,
      artifacts: [
        {
          artifact,
          markdown: "---\ntitle: DSRS\n---\n\n# Password reset\nUsers can reset a forgotten password.\n",
        },
      ],
      runId: "00000000-0000-4000-8000-000000000004",
      snapshot,
    });

    expect(plan.runId).toBe("00000000-0000-4000-8000-000000000004");
    expect(plan.artifactIds).toEqual([artifact.id]);
    expect(plan.cases).toHaveLength(1);
    expect(plan.cases[0]).toMatchObject({
      title: "Verify: Password reset",
      risk: "session_change",
      requiresApproval: true,
      sources: [{ artifactId: artifact.id, section: "Password reset" }],
      coverage: { status: "mapped", discoveredPaths: ["/password-reset"] },
    });
  });

  it("marks coverage as not applicable without discovery", async () => {
    const plan = await new DeterministicRequirementsPlanGenerator().generate({
      project,
      artifacts: [{ artifact, markdown: "# Public homepage\nVisitors can view the homepage.\n" }],
    });

    expect(plan.cases[0]?.coverage.status).toBe("not-applicable");
    expect(plan.warnings).toContain(
      "No discovery snapshot was supplied; coverage mapping was not performed.",
    );
  });

  it("rejects empty artifact input", async () => {
    await expect(
      new DeterministicRequirementsPlanGenerator().generate({ project, artifacts: [] }),
    ).rejects.toThrow("Cannot generate test cases without project artifacts.");
  });
});
