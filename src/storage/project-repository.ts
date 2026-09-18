import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

import {
  ArtifactSchema,
  ArtifactTypeSchema,
  ProjectSchema,
  type Artifact,
  type ArtifactType,
  type Project,
} from "../domain.js";

export type NewProject = Project;
export type NewArtifact = Artifact;

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`);
  }
}

type StoredProject = {
  id: string;
  name: string;
  target_url: string | null;
  created_at: string;
};

type StoredArtifact = {
  id: string;
  project_id: string;
  type: string;
  title: string;
  file_path: string;
  created_at: string;
  updated_at: string;
};

export class ProjectRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  createProject(project: NewProject): Project {
    const parsed = ProjectSchema.parse(project);
    this.db
      .prepare("INSERT INTO projects (id, name, target_url, created_at) VALUES (?, ?, ?, ?)")
      .run(parsed.id, parsed.name, parsed.targetUrl ?? null, parsed.createdAt);
    return this.getProject(parsed.id);
  }

  getProject(projectId: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
      StoredProject | undefined;
    if (!row) {
      throw new ProjectNotFoundError(projectId);
    }

    return ProjectSchema.parse({
      id: row.id,
      name: row.name,
      targetUrl: row.target_url ?? undefined,
      createdAt: row.created_at,
    });
  }

  listProjects(): Project[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY created_at")
      .all()
      .map((row) => this.toProject(row as StoredProject));
  }

  createArtifact(artifact: NewArtifact): Artifact {
    const parsed = ArtifactSchema.parse(artifact);
    this.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, type, title, file_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.projectId,
        parsed.type,
        parsed.title,
        parsed.filePath,
        parsed.createdAt,
        parsed.updatedAt,
      );
    return this.getArtifact(parsed.id);
  }

  getArtifact(artifactId: string): Artifact {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as
      StoredArtifact | undefined;
    if (!row) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    return this.toArtifact(row);
  }

  listArtifacts(projectId: string, type?: ArtifactType): Artifact[] {
    const parsedType = type ? ArtifactTypeSchema.parse(type) : undefined;
    const rows = parsedType
      ? this.db
          .prepare("SELECT * FROM artifacts WHERE project_id = ? AND type = ? ORDER BY created_at")
          .all(projectId, parsedType)
      : this.db.prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at").all(projectId);
    return rows.map((row) => this.toArtifact(row as StoredArtifact));
  }

  appendEvent(projectId: string, type: string, payload: Record<string, unknown>, createdAt: string): void {
    this.db
      .prepare("INSERT INTO project_events (project_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(projectId, type, JSON.stringify(payload), createdAt);
  }

  listEvents(
    projectId: string,
  ): Array<{ type: string; payload: Record<string, unknown>; createdAt: string }> {
    return this.db
      .prepare("SELECT type, payload_json, created_at FROM project_events WHERE project_id = ? ORDER BY id")
      .all(projectId)
      .map((row) => {
        const typed = row as { type: string; payload_json: string; created_at: string };
        return { type: typed.type, payload: JSON.parse(typed.payload_json), createdAt: typed.created_at };
      });
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        target_url TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private toProject(row: StoredProject): Project {
    return ProjectSchema.parse({
      id: row.id,
      name: row.name,
      targetUrl: row.target_url ?? undefined,
      createdAt: row.created_at,
    });
  }

  private toArtifact(row: StoredArtifact): Artifact {
    return ArtifactSchema.parse({
      id: row.id,
      projectId: row.project_id,
      type: row.type,
      title: row.title,
      filePath: row.file_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
