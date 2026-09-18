import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { TestRunStateSchema, type AuditEvent, type TestRunState } from "../../domain/index.js";

/**
 * SQLite-backed durable state. Interface is deliberately narrow (get/save/
 * list/appendAudit) so a later PostgreSQL implementation is a drop-in
 * replacement — nothing outside this file knows or cares that SQLite is
 * involved.
 */
export interface RunRepository {
  save(state: TestRunState): void;
  get(runId: string): TestRunState | undefined;
  list(): TestRunState[];
  appendAudit(runId: string, event: AuditEvent): void;
  close(): void;
}

/** Spec-facing alias — identical interface, same implementation. */
export type TestRunRepository = RunRepository;

export class SqliteRunRepository implements RunRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  save(state: TestRunState): void {
    const parsed = TestRunStateSchema.parse(state);
    this.db
      .prepare(
        `INSERT INTO runs (run_id, state_json, updated_at) VALUES (@runId, @stateJson, @updatedAt)
         ON CONFLICT(run_id) DO UPDATE SET state_json = @stateJson, updated_at = @updatedAt`,
      )
      .run({
        runId: parsed.runId,
        stateJson: JSON.stringify(parsed),
        updatedAt: new Date().toISOString(),
      });
  }

  get(runId: string): TestRunState | undefined {
    const row = this.db.prepare(`SELECT state_json FROM runs WHERE run_id = ?`).get(runId) as
      { state_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return TestRunStateSchema.parse(JSON.parse(row.state_json));
  }

  list(): TestRunState[] {
    const rows = this.db.prepare(`SELECT state_json FROM runs ORDER BY updated_at DESC`).all() as Array<{
      state_json: string;
    }>;
    return rows.map((row) => TestRunStateSchema.parse(JSON.parse(row.state_json)));
  }

  appendAudit(runId: string, event: AuditEvent): void {
    const state = this.get(runId);
    if (!state) {
      throw new Error(`Cannot append an audit event to unknown run ${runId}.`);
    }
    state.auditEvents.push(event);
    this.save(state);
  }

  close(): void {
    this.db.close();
  }
}
