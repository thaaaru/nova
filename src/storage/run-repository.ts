import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

import {
  ApprovalDecisionSchema,
  AppSnapshotSchema,
  ExecutionResultSchema,
  HarnessRunInputSchema,
  RunRecordSchema,
  RunStatusSchema,
  TestPlanSchema,
  type ApprovalDecision,
  type AppSnapshot,
  type ExecutionResult,
  type HarnessRunInput,
  type RunRecord,
  type RunStatus,
  type TestPlan,
} from "../domain.js";

export type NewRun = {
  id: string;
  input: HarnessRunInput;
  status: RunStatus;
  createdAt: string;
};

type StoredRun = {
  id: string;
  target_url: string;
  goal: string;
  status: string;
  input_json: string;
  approval_json: string | null;
  created_at: string;
  updated_at: string;
};

export class RunRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  createRun(run: NewRun): RunRecord {
    const input = HarnessRunInputSchema.parse(run.input);
    const status = RunStatusSchema.parse(run.status);

    this.db
      .prepare(
        `INSERT INTO runs (id, target_url, goal, status, input_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, input.targetUrl, input.goal, status, JSON.stringify(input), run.createdAt, run.createdAt);

    return this.getRun(run.id);
  }

  getRun(runId: string): RunRecord {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as StoredRun | undefined;
    if (!row) {
      throw new Error(`Run not found: ${runId}`);
    }

    return this.toRunRecord(row);
  }

  listRuns(): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as StoredRun[];
    return rows.map((row) => this.toRunRecord(row));
  }

  updateStatus(runId: string, status: RunStatus, updatedAt: string): void {
    const result = this.db
      .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
      .run(RunStatusSchema.parse(status), updatedAt, runId);
    this.assertRunWasUpdated(runId, result.changes);
  }

  saveSnapshot(runId: string, snapshot: AppSnapshot, savedAt: string): void {
    const parsed = AppSnapshotSchema.parse(snapshot);
    this.db
      .prepare(
        `INSERT INTO snapshots (run_id, snapshot_json, saved_at)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, saved_at = excluded.saved_at`,
      )
      .run(runId, JSON.stringify(parsed), savedAt);
  }

  getSnapshot(runId: string): AppSnapshot | undefined {
    const row = this.db.prepare("SELECT snapshot_json FROM snapshots WHERE run_id = ?").get(runId) as
      { snapshot_json: string } | undefined;
    return row ? AppSnapshotSchema.parse(JSON.parse(row.snapshot_json)) : undefined;
  }

  savePlan(runId: string, plan: TestPlan, savedAt: string): void {
    const parsed = TestPlanSchema.parse(plan);
    this.db
      .prepare(
        `INSERT INTO plans (run_id, plan_json, saved_at)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET plan_json = excluded.plan_json, saved_at = excluded.saved_at`,
      )
      .run(runId, JSON.stringify(parsed), savedAt);
  }

  getPlan(runId: string): TestPlan | undefined {
    const row = this.db.prepare("SELECT plan_json FROM plans WHERE run_id = ?").get(runId) as
      { plan_json: string } | undefined;
    return row ? TestPlanSchema.parse(JSON.parse(row.plan_json)) : undefined;
  }

  saveExecution(runId: string, execution: ExecutionResult, savedAt: string): void {
    const parsed = ExecutionResultSchema.parse(execution);
    this.db
      .prepare(
        `INSERT INTO executions (run_id, execution_json, saved_at)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET execution_json = excluded.execution_json, saved_at = excluded.saved_at`,
      )
      .run(runId, JSON.stringify(parsed), savedAt);
  }

  getExecution(runId: string): ExecutionResult | undefined {
    const row = this.db.prepare("SELECT execution_json FROM executions WHERE run_id = ?").get(runId) as
      { execution_json: string } | undefined;
    return row ? ExecutionResultSchema.parse(JSON.parse(row.execution_json)) : undefined;
  }

  saveApproval(runId: string, approval: ApprovalDecision, savedAt: string): void {
    const parsed = ApprovalDecisionSchema.parse(approval);
    const result = this.db
      .prepare("UPDATE runs SET approval_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(parsed), savedAt, runId);
    this.assertRunWasUpdated(runId, result.changes);
  }

  appendEvent(runId: string, type: string, payload: Record<string, unknown>, createdAt: string): void {
    this.db
      .prepare("INSERT INTO run_events (run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(runId, type, JSON.stringify(payload), createdAt);
  }

  listEvents(runId: string): Array<{ type: string; payload: Record<string, unknown>; createdAt: string }> {
    return this.db
      .prepare("SELECT type, payload_json, created_at FROM run_events WHERE run_id = ? ORDER BY id")
      .all(runId)
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
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        target_url TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        approval_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plans (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        plan_json TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );


      CREATE TABLE IF NOT EXISTS executions (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        execution_json TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private toRunRecord(row: StoredRun): RunRecord {
    return RunRecordSchema.parse({
      id: row.id,
      targetUrl: row.target_url,
      goal: row.goal,
      status: row.status,
      input: JSON.parse(row.input_json),
      approval: row.approval_json ? ApprovalDecisionSchema.parse(JSON.parse(row.approval_json)) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private assertRunWasUpdated(runId: string, changes: number | bigint): void {
    if (changes === 0 || changes === 0n) {
      throw new Error(`Run not found: ${runId}`);
    }
  }
}
