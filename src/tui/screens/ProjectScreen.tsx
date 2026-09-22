import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";

import type { NovaRuntime } from "../../cli/context.js";
import type { Project } from "../../domain/index.js";
import {
  createProject,
  deleteProject,
  listMapsInProject,
  listProjects,
} from "../../services/testmap/project-service.js";
import { palette } from "../theme/palette.js";

type Mode =
  | { kind: "projects" }
  | { kind: "newProject" }
  | { kind: "deleteProjectPick" }
  | { kind: "deleteProject"; project: Project }
  | { kind: "apps"; project: Project };

type ProjectScreenProps = {
  runtime: NovaRuntime;
  /** Called when the operator picks an existing app to make active — routes back to Home on that map. */
  onSelectApp: (mapId: string) => void;
  /** Called when the operator asks for a new app inside a known project — routes to discovery pre-scoped to it. */
  onCreateApp: (projectId: string) => void;
  onBack: () => void;
};

const NEW_PROJECT_VALUE = "__new_project__";
const DELETE_PROJECT_VALUE = "__delete_project__";
const NEW_APP_VALUE = "__new_app__";

/**
 * "Manage projects & applications" — the single place Projects themselves
 * are created, selected, and deleted, and where an operator can see every
 * application already discovered inside one before adding another. Three
 * flat panes (projects -> that project's apps, or projects -> pick one to
 * delete), never a nested wizard: everything here is a thin read of
 * `project-service`'s own list/create/delete calls, no new business logic.
 */
export function ProjectScreen({
  runtime,
  onSelectApp,
  onCreateApp,
  onBack,
}: ProjectScreenProps): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>(() => listProjects(runtime));
  const [mode, setMode] = useState<Mode>({ kind: "projects" });
  const [newProjectDraft, setNewProjectDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((_input, key) => {
    if (!key.escape) {
      return;
    }
    if (mode.kind === "projects") {
      onBack();
      return;
    }
    setMode({ kind: "projects" });
    setError(undefined);
  });

  function submitNewProject(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      setError("Enter a project name, or press Esc to cancel.");
      return;
    }
    const created = createProject(runtime, { name: trimmed });
    setProjects((previous) => [created, ...previous]);
    setNewProjectDraft("");
    setError(undefined);
    setMode({ kind: "apps", project: created });
  }

  if (mode.kind === "newProject") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
        <Text bold color={palette.blue}>
          NEW PROJECT
        </Text>
        <Text>Project name</Text>
        <TextInput value={newProjectDraft} onChange={setNewProjectDraft} onSubmit={submitNewProject} />
        {error ? <Text color={palette.red}>{error}</Text> : null}
        <Text color={palette.muted}>[Esc] Back</Text>
      </Box>
    );
  }

  if (mode.kind === "deleteProjectPick") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
        <Text bold color={palette.red}>
          DELETE A PROJECT
        </Text>
        <Text>Which project?</Text>
        <SelectInput
          items={projects.map((project) => ({ label: project.name, value: project.id }))}
          onSelect={(item) => {
            const project = projects.find((candidate) => candidate.id === item.value);
            if (project) {
              setMode({ kind: "deleteProject", project });
            }
          }}
        />
        <Text color={palette.muted}>[Esc] Back</Text>
      </Box>
    );
  }

  if (mode.kind === "deleteProject") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
        <Text bold color={palette.red}>
          DELETE PROJECT
        </Text>
        <Text>
          Delete <Text color={palette.cyan}>{mode.project.name}</Text> and every application inside it? This
          cannot be undone.
        </Text>
        <SelectInput
          items={[
            { label: "Yes, delete it", value: "confirm" },
            { label: "No, keep it", value: "cancel" },
          ]}
          onSelect={(item) => {
            if (item.value === "confirm") {
              const projectId = mode.project.id;
              deleteProject(runtime, projectId);
              setProjects((previous) => previous.filter((project) => project.id !== projectId));
            }
            setMode({ kind: "projects" });
          }}
        />
      </Box>
    );
  }

  if (mode.kind === "apps") {
    const apps = listMapsInProject(runtime, mode.project.id);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
        <Text bold color={palette.blue}>
          {mode.project.name.toUpperCase()} — APPLICATIONS
        </Text>
        {apps.length === 0 ? <Text color={palette.muted}>No applications in this project yet.</Text> : null}
        <SelectInput
          items={[
            ...apps.map((map) => ({
              label: `${map.applicationName} (${map.environment}) — ${map.areas.reduce((total, area) => total + area.journeys.length, 0)} journey(s)`,
              value: map.id,
            })),
            { label: "+ New app", value: NEW_APP_VALUE },
          ]}
          onSelect={(item) => {
            if (item.value === NEW_APP_VALUE) {
              onCreateApp(mode.project.id);
            } else {
              onSelectApp(item.value);
            }
          }}
        />
        <Text color={palette.muted}>[Esc] Back to projects</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        PROJECTS
      </Text>
      {projects.length === 0 ? (
        <Text color={palette.muted}>No projects yet — create one to start discovering applications.</Text>
      ) : null}
      <SelectInput
        items={[
          ...projects.map((project) => ({ label: project.name, value: project.id })),
          { label: "+ New project", value: NEW_PROJECT_VALUE },
          ...(projects.length > 0 ? [{ label: "Delete a project", value: DELETE_PROJECT_VALUE }] : []),
        ]}
        onSelect={(item) => {
          if (item.value === NEW_PROJECT_VALUE) {
            setMode({ kind: "newProject" });
            return;
          }
          if (item.value === DELETE_PROJECT_VALUE) {
            setMode({ kind: "deleteProjectPick" });
            return;
          }
          const project = projects.find((candidate) => candidate.id === item.value);
          if (project) {
            setMode({ kind: "apps", project });
          }
        }}
      />
      <Text color={palette.muted}>[Esc] Back to Home</Text>
    </Box>
  );
}
