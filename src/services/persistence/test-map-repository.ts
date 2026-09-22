import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  ApplicationTestMapSchema,
  type ApplicationTestMap,
  type Assertion,
  type TestDataFixture,
  type TestPersona,
  type TestStep,
  type UserJourney,
} from "../../domain/index.js";

/**
 * Areas/journeys/personas/fixtures are stored nested inside one
 * ApplicationTestMap row (they are versioned and edited together as one
 * document), never as separate normalized tables — SQLite here is a
 * durable JSON document store, same pattern as SqliteRunRepository. The
 * narrower JourneyRepository/PersonaRepository/FixtureRepository
 * interfaces below are thin, typed views over that one document so
 * calling code never has to know about the nesting, and a future
 * PostgreSQL implementation is free to normalize it however it likes.
 */
export interface ApplicationTestMapRepository {
  save(map: ApplicationTestMap): void;
  get(mapId: string): ApplicationTestMap | undefined;
  list(): ApplicationTestMap[];
  delete(mapId: string): void;
  acquireFixtureLock(mapId: string, fixtureId: string, runId: string): boolean;
  releaseFixtureLock(mapId: string, fixtureId: string, runId: string): void;
  isFixtureLocked(mapId: string, fixtureId: string): boolean;
  close(): void;
}

export class SqliteApplicationTestMapRepository implements ApplicationTestMapRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS test_maps (
        map_id TEXT PRIMARY KEY,
        map_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fixture_locks (
        map_id TEXT NOT NULL,
        fixture_id TEXT NOT NULL,
        locked_by_run_id TEXT NOT NULL,
        locked_at TEXT NOT NULL,
        PRIMARY KEY (map_id, fixture_id)
      );
    `);
  }

  save(map: ApplicationTestMap): void {
    const parsed = ApplicationTestMapSchema.parse(map);
    this.db
      .prepare(
        `INSERT INTO test_maps (map_id, map_json, updated_at) VALUES (@mapId, @mapJson, @updatedAt)
         ON CONFLICT(map_id) DO UPDATE SET map_json = @mapJson, updated_at = @updatedAt`,
      )
      .run({ mapId: parsed.id, mapJson: JSON.stringify(parsed), updatedAt: new Date().toISOString() });
  }

  get(mapId: string): ApplicationTestMap | undefined {
    const row = this.db.prepare(`SELECT map_json FROM test_maps WHERE map_id = ?`).get(mapId) as
      { map_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return ApplicationTestMapSchema.parse(JSON.parse(row.map_json));
  }

  list(): ApplicationTestMap[] {
    const rows = this.db.prepare(`SELECT map_json FROM test_maps ORDER BY updated_at DESC`).all() as Array<{
      map_json: string;
    }>;
    return rows.map((row) => ApplicationTestMapSchema.parse(JSON.parse(row.map_json)));
  }

  delete(mapId: string): void {
    this.db.prepare(`DELETE FROM test_maps WHERE map_id = ?`).run(mapId);
    this.db.prepare(`DELETE FROM fixture_locks WHERE map_id = ?`).run(mapId);
  }

  /**
   * Acquires an exclusive lock on a fixture for one run. Returns false
   * (never throws) if another run already holds it — callers decide
   * whether that is a hard error or a "wait/pick another fixture" prompt.
   */
  acquireFixtureLock(mapId: string, fixtureId: string, runId: string): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO fixture_locks (map_id, fixture_id, locked_by_run_id, locked_at) VALUES (?, ?, ?, ?)`,
        )
        .run(mapId, fixtureId, runId, new Date().toISOString());
      return true;
    } catch {
      const existing = this.db
        .prepare(`SELECT locked_by_run_id FROM fixture_locks WHERE map_id = ? AND fixture_id = ?`)
        .get(mapId, fixtureId) as { locked_by_run_id: string } | undefined;
      return existing?.locked_by_run_id === runId;
    }
  }

  releaseFixtureLock(mapId: string, fixtureId: string, runId: string): void {
    this.db
      .prepare(`DELETE FROM fixture_locks WHERE map_id = ? AND fixture_id = ? AND locked_by_run_id = ?`)
      .run(mapId, fixtureId, runId);
  }

  isFixtureLocked(mapId: string, fixtureId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM fixture_locks WHERE map_id = ? AND fixture_id = ?`)
      .get(mapId, fixtureId);
    return row !== undefined;
  }

  close(): void {
    this.db.close();
  }
}

function findJourney(
  map: ApplicationTestMap,
  journeyId: string,
): { areaIndex: number; journeyIndex: number; journey: UserJourney } | undefined {
  for (let areaIndex = 0; areaIndex < map.areas.length; areaIndex += 1) {
    const journeyIndex = map.areas[areaIndex].journeys.findIndex((journey) => journey.id === journeyId);
    if (journeyIndex !== -1) {
      return { areaIndex, journeyIndex, journey: map.areas[areaIndex].journeys[journeyIndex] };
    }
  }
  return undefined;
}

/**
 * A typed view over one map's journeys. Mutating methods read-modify-write
 * the whole map document through ApplicationTestMapRepository, bumping
 * `updatedAt` — there is no separate journeys table to fall out of sync.
 */
export interface JourneyRepository {
  list(mapId: string, areaId?: string): UserJourney[];
  get(mapId: string, journeyId: string): UserJourney | undefined;
  setStatus(mapId: string, journeyId: string, status: UserJourney["status"]): UserJourney;
  setCheckpointSteps(
    mapId: string,
    journeyId: string,
    checkpointId: string,
    steps: TestStep[],
    assertions: Assertion[],
  ): UserJourney;
  recordRunOutcome(
    mapId: string,
    journeyId: string,
    outcome: NonNullable<UserJourney["lastRunOutcome"]>,
    runAt: string,
  ): void;
}

export class MapBackedJourneyRepository implements JourneyRepository {
  constructor(private readonly maps: ApplicationTestMapRepository) {}

  list(mapId: string, areaId?: string): UserJourney[] {
    const map = this.requireMap(mapId);
    return map.areas.filter((area) => !areaId || area.id === areaId).flatMap((area) => area.journeys);
  }

  get(mapId: string, journeyId: string): UserJourney | undefined {
    const map = this.requireMap(mapId);
    return findJourney(map, journeyId)?.journey;
  }

  setStatus(mapId: string, journeyId: string, status: UserJourney["status"]): UserJourney {
    const map = this.requireMap(mapId);
    const found = findJourney(map, journeyId);
    if (!found) {
      throw new Error(`Unknown journey ${journeyId} in map ${mapId}.`);
    }
    const updatedJourney: UserJourney = { ...found.journey, status };
    const updatedAreas = [...map.areas];
    const journeys = [...updatedAreas[found.areaIndex].journeys];
    journeys[found.journeyIndex] = updatedJourney;
    updatedAreas[found.areaIndex] = { ...updatedAreas[found.areaIndex], journeys };
    this.maps.save({ ...map, areas: updatedAreas, updatedAt: new Date().toISOString() });
    return updatedJourney;
  }

  setCheckpointSteps(
    mapId: string,
    journeyId: string,
    checkpointId: string,
    steps: TestStep[],
    assertions: Assertion[],
  ): UserJourney {
    const map = this.requireMap(mapId);
    const found = findJourney(map, journeyId);
    if (!found) {
      throw new Error(`Unknown journey ${journeyId} in map ${mapId}.`);
    }
    const checkpointIndex = found.journey.checkpoints.findIndex(
      (checkpoint) => checkpoint.id === checkpointId,
    );
    if (checkpointIndex === -1) {
      throw new Error(`Unknown checkpoint ${checkpointId} on journey ${journeyId}.`);
    }
    const checkpoints = [...found.journey.checkpoints];
    checkpoints[checkpointIndex] = { ...checkpoints[checkpointIndex], steps, assertions };
    const updatedJourney: UserJourney = { ...found.journey, checkpoints };
    const updatedAreas = [...map.areas];
    const journeys = [...updatedAreas[found.areaIndex].journeys];
    journeys[found.journeyIndex] = updatedJourney;
    updatedAreas[found.areaIndex] = { ...updatedAreas[found.areaIndex], journeys };
    this.maps.save({ ...map, areas: updatedAreas, updatedAt: new Date().toISOString() });
    return updatedJourney;
  }

  recordRunOutcome(
    mapId: string,
    journeyId: string,
    outcome: NonNullable<UserJourney["lastRunOutcome"]>,
    runAt: string,
  ): void {
    const map = this.requireMap(mapId);
    const found = findJourney(map, journeyId);
    if (!found) {
      throw new Error(`Unknown journey ${journeyId} in map ${mapId}.`);
    }
    const updatedJourney: UserJourney = { ...found.journey, lastRunOutcome: outcome, lastRunAt: runAt };
    const updatedAreas = [...map.areas];
    const journeys = [...updatedAreas[found.areaIndex].journeys];
    journeys[found.journeyIndex] = updatedJourney;
    updatedAreas[found.areaIndex] = { ...updatedAreas[found.areaIndex], journeys };
    this.maps.save({ ...map, areas: updatedAreas, updatedAt: new Date().toISOString() });
  }

  private requireMap(mapId: string): ApplicationTestMap {
    const map = this.maps.get(mapId);
    if (!map) {
      throw new Error(`Unknown application test map: ${mapId}`);
    }
    return map;
  }
}

export interface PersonaRepository {
  list(mapId: string): TestPersona[];
  get(mapId: string, personaId: string): TestPersona | undefined;
}

export class MapBackedPersonaRepository implements PersonaRepository {
  constructor(private readonly maps: ApplicationTestMapRepository) {}

  list(mapId: string): TestPersona[] {
    return this.requireMap(mapId).personas;
  }

  get(mapId: string, personaId: string): TestPersona | undefined {
    return this.requireMap(mapId).personas.find((persona) => persona.id === personaId);
  }

  private requireMap(mapId: string): ApplicationTestMap {
    const map = this.maps.get(mapId);
    if (!map) {
      throw new Error(`Unknown application test map: ${mapId}`);
    }
    return map;
  }
}

export interface FixtureRepository {
  list(mapId: string): TestDataFixture[];
  get(mapId: string, fixtureId: string): TestDataFixture | undefined;
}

export class MapBackedFixtureRepository implements FixtureRepository {
  constructor(private readonly maps: ApplicationTestMapRepository) {}

  list(mapId: string): TestDataFixture[] {
    return this.requireMap(mapId).fixtures;
  }

  get(mapId: string, fixtureId: string): TestDataFixture | undefined {
    return this.requireMap(mapId).fixtures.find((fixture) => fixture.id === fixtureId);
  }

  private requireMap(mapId: string): ApplicationTestMap {
    const map = this.maps.get(mapId);
    if (!map) {
      throw new Error(`Unknown application test map: ${mapId}`);
    }
    return map;
  }
}
