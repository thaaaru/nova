import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

import { KnowledgeEntrySchema, type KnowledgeCategory, type KnowledgeEntry } from "../domain.js";

type StoredKnowledgeEntry = {
  id: string;
  run_id: string;
  target_url: string;
  category: string;
  title: string;
  summary: string;
  detail: string;
  tags_json: string;
  created_at: string;
};

export type KnowledgeSearchOptions = {
  category?: KnowledgeCategory;
  targetUrl?: string;
  limit?: number;
};

/**
 * A separate SQLite database from the run database (data/knowledge.sqlite by
 * default) — knowledge accumulates across runs and targets, so it's queried
 * independently of any single run's history.
 */
export class KnowledgeRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  addEntries(entries: KnowledgeEntry[]): void {
    const insert = this.db.prepare(
      `INSERT INTO knowledge_entries (id, run_id, target_url, category, title, summary, detail, tags_json, created_at)
       VALUES (@id, @runId, @targetUrl, @category, @title, @summary, @detail, @tagsJson, @createdAt)`,
    );
    const insertAll = this.db.transaction((rows: KnowledgeEntry[]) => {
      for (const row of rows) {
        const parsed = KnowledgeEntrySchema.parse(row);
        insert.run({ ...parsed, tagsJson: JSON.stringify(parsed.tags) });
      }
    });
    insertAll(entries);
  }

  getEntry(id: string): KnowledgeEntry {
    const row = this.db.prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(id) as
      StoredKnowledgeEntry | undefined;
    if (!row) {
      throw new Error(`Knowledge entry not found: ${id}`);
    }
    return this.toEntry(row);
  }

  list(options: KnowledgeSearchOptions = {}): KnowledgeEntry[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (options.category) {
      clauses.push("category = @category");
      params.category = options.category;
    }
    if (options.targetUrl) {
      clauses.push("target_url = @targetUrl");
      params.targetUrl = options.targetUrl;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = options.limit ?? 50;
    const rows = this.db
      .prepare(`SELECT * FROM knowledge_entries ${where} ORDER BY created_at DESC LIMIT @limit`)
      .all({ ...params, limit }) as StoredKnowledgeEntry[];
    return rows.map((row) => this.toEntry(row));
  }

  search(query: string, limit = 50): KnowledgeEntry[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_entries
         WHERE title LIKE @like OR summary LIKE @like OR detail LIKE @like OR tags_json LIKE @like
         ORDER BY created_at DESC LIMIT @limit`,
      )
      .all({ like, limit }) as StoredKnowledgeEntry[];
    return rows.map((row) => this.toEntry(row));
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_entries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        target_url TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_entries_category ON knowledge_entries (category);
      CREATE INDEX IF NOT EXISTS idx_knowledge_entries_target_url ON knowledge_entries (target_url);
    `);
  }

  private toEntry(row: StoredKnowledgeEntry): KnowledgeEntry {
    return KnowledgeEntrySchema.parse({
      id: row.id,
      runId: row.run_id,
      targetUrl: row.target_url,
      category: row.category,
      title: row.title,
      summary: row.summary,
      detail: row.detail,
      tags: JSON.parse(row.tags_json),
      createdAt: row.created_at,
    });
  }
}
