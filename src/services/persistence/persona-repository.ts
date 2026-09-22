import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { ProjectPersonaSchema, type ProjectPersona } from "../../domain/index.js";

/**
 * Same durable JSON-document-store pattern as SqliteProjectRepository:
 * one row per persona, the row's document is the source of truth, no
 * separate normalized columns to fall out of sync. `project_id` is
 * pulled out as its own column purely to index and filter `list` by
 * project without deserializing every row.
 */
export interface PersonaRepository {
  save(persona: ProjectPersona): void;
  get(personaId: string): ProjectPersona | undefined;
  list(projectId: string): ProjectPersona[];
  delete(personaId: string): void;
  close(): void;
}

export class SqlitePersonaRepository implements PersonaRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personas (
        persona_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        persona_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_personas_project ON personas(project_id);
    `);
  }

  save(persona: ProjectPersona): void {
    const parsed = ProjectPersonaSchema.parse(persona);
    this.db
      .prepare(
        `INSERT INTO personas (persona_id, project_id, persona_json, updated_at) VALUES (@personaId, @projectId, @personaJson, @updatedAt)
         ON CONFLICT(persona_id) DO UPDATE SET project_id = @projectId, persona_json = @personaJson, updated_at = @updatedAt`,
      )
      .run({
        personaId: parsed.id,
        projectId: parsed.projectId,
        personaJson: JSON.stringify(parsed),
        updatedAt: new Date().toISOString(),
      });
  }

  get(personaId: string): ProjectPersona | undefined {
    const row = this.db.prepare(`SELECT persona_json FROM personas WHERE persona_id = ?`).get(personaId) as
      { persona_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return ProjectPersonaSchema.parse(JSON.parse(row.persona_json));
  }

  delete(personaId: string): void {
    this.db.prepare(`DELETE FROM personas WHERE persona_id = ?`).run(personaId);
  }

  list(projectId: string): ProjectPersona[] {
    const rows = this.db
      .prepare(`SELECT persona_json FROM personas WHERE project_id = ? ORDER BY updated_at DESC`)
      .all(projectId) as Array<{ persona_json: string }>;
    return rows.map((row) => ProjectPersonaSchema.parse(JSON.parse(row.persona_json)));
  }

  close(): void {
    this.db.close();
  }
}
