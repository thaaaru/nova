import { randomUUID } from "node:crypto";

import type { Project } from "../../domain/index.js";
import type { NovaRuntime } from "../../cli/context.js";

/**
 * The single Project service surface — creates and lists the groupings
 * that Application Test Maps are added into. Deliberately tiny: a
 * Project is just a name and an id right now, nothing policy-bearing
 * lives on it yet.
 */
export function createProject(runtime: NovaRuntime, options: { name: string }): Project {
  const trimmed = options.name.trim();
  if (trimmed.length === 0) {
    throw new Error("Project name must not be empty.");
  }
  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID(),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
  };
  runtime.projects.save(project);
  return project;
}

export function listProjects(runtime: NovaRuntime): Project[] {
  return runtime.projects.list();
}

export function getProject(runtime: NovaRuntime, projectId: string): Project | undefined {
  return runtime.projects.get(projectId);
}

/** Every ApplicationTestMap added inside a given project, most-recently-updated first. */
export function listMapsInProject(runtime: NovaRuntime, projectId: string) {
  return runtime.testMaps.list().filter((map) => map.projectId === projectId);
}

/**
 * Deletes a Project and every Application Test Map inside it — a Project
 * is purely an organizational grouping, so nothing meaningful survives it
 * once it's gone; leaving orphaned maps behind would just make them
 * unreachable from every screen that lists maps by project.
 */
export function deleteProject(runtime: NovaRuntime, projectId: string): void {
  for (const map of listMapsInProject(runtime, projectId)) {
    runtime.testMaps.delete(map.id);
  }
  runtime.projects.delete(projectId);
}
