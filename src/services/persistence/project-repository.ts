import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { ProjectSchema, type Project } from "../../domain/index.js";

/**
 * Same durable JSON-document-store pattern as
 * SqliteApplicationTestMapRepository: one row per project, the row's
 * document is the source of truth, no separate normalized columns to
 * fall out of sync.
 */
export interface ProjectRepository {
  save(project: Project): void;
  get(projectId: string): Project | undefined;
  list(): Project[];
  delete(projectId: string): void;
  close(): void;
}

export class SqliteProjectRepository implements ProjectRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        project_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  save(project: Project): void {
    const parsed = ProjectSchema.parse(project);
    this.db
      .prepare(
        `INSERT INTO projects (project_id, project_json, updated_at) VALUES (@projectId, @projectJson, @updatedAt)
         ON CONFLICT(project_id) DO UPDATE SET project_json = @projectJson, updated_at = @updatedAt`,
      )
      .run({ projectId: parsed.id, projectJson: JSON.stringify(parsed), updatedAt: new Date().toISOString() });
  }

  get(projectId: string): Project | undefined {
    const row = this.db.prepare(`SELECT project_json FROM projects WHERE project_id = ?`).get(projectId) as
      { project_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return ProjectSchema.parse(JSON.parse(row.project_json));
  }

  delete(projectId: string): void {
    this.db.prepare(`DELETE FROM projects WHERE project_id = ?`).run(projectId);
  }

  list(): Project[] {
    const rows = this.db.prepare(`SELECT project_json FROM projects ORDER BY updated_at DESC`).all() as Array<{
      project_json: string;
    }>;
    return rows.map((row) => ProjectSchema.parse(JSON.parse(row.project_json)));
  }

  close(): void {
    this.db.close();
  }
}
