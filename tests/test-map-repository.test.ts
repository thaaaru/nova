import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteApplicationTestMapRepository } from "../src/services/persistence/test-map-repository.js";
import { sampleApplicationTestMap } from "../fixtures/sample-application-test-map.js";

let tempDir: string;
let repository: SqliteApplicationTestMapRepository;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-test-map-repo-test-"));
  repository = new SqliteApplicationTestMapRepository(join(tempDir, "maps.sqlite"));
  repository.save(sampleApplicationTestMap);
});

afterEach(() => {
  repository.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteApplicationTestMapRepository fixture locks", () => {
  it("acquires a lock for the first run, then refuses a distinct second run", () => {
    const runA = randomUUID();
    const runB = randomUUID();

    expect(repository.acquireFixtureLock(sampleApplicationTestMap.id, "sandbox-payment-card", runA)).toBe(
      true,
    );
    expect(repository.acquireFixtureLock(sampleApplicationTestMap.id, "sandbox-payment-card", runB)).toBe(
      false,
    );
    expect(repository.isFixtureLocked(sampleApplicationTestMap.id, "sandbox-payment-card")).toBe(true);
  });

  it("is idempotent when the same run re-acquires its own held lock", () => {
    const runId = randomUUID();

    expect(repository.acquireFixtureLock(sampleApplicationTestMap.id, "sandbox-payment-card", runId)).toBe(
      true,
    );
    expect(repository.acquireFixtureLock(sampleApplicationTestMap.id, "sandbox-payment-card", runId)).toBe(
      true,
    );
  });

  it("frees the lock for another run after release", () => {
    const runA = randomUUID();
    const runB = randomUUID();

    expect(repository.acquireFixtureLock(sampleApplicationTestMap.id, "sandbox-payment-card", runA)).toBe(
      true,
    );
    repository.releaseFixtureLock(sampleApplicationTestMap.id, "sandbox-payment-card", runA);

    expect(repository.isFixtureLocked(sampleApplicationTestMap.id, "sandbox-payment-card")).toBe(false);
    expect(repository.acquireFixtureLock(sampleApplicationTestMap.id, "sandbox-payment-card", runB)).toBe(
      true,
    );
  });

  it("releasing a lock held by a different run does not free it", () => {
    const runA = randomUUID();
    const runB = randomUUID();

    expect(repository.acquireFixtureLock(sampleApplicationTestMap.id, "sandbox-payment-card", runA)).toBe(
      true,
    );
    repository.releaseFixtureLock(sampleApplicationTestMap.id, "sandbox-payment-card", runB);

    expect(repository.isFixtureLocked(sampleApplicationTestMap.id, "sandbox-payment-card")).toBe(true);
  });

  it("tracks locks independently per fixture id", () => {
    const runA = randomUUID();
    const runB = randomUUID();

    expect(repository.acquireFixtureLock(sampleApplicationTestMap.id, "sandbox-payment-card", runA)).toBe(
      true,
    );
    expect(repository.acquireFixtureLock(sampleApplicationTestMap.id, "valid-coupon-code", runB)).toBe(true);
  });
});

describe("SqliteApplicationTestMapRepository save/get/list", () => {
  it("round-trips a saved map through get()", () => {
    const fetched = repository.get(sampleApplicationTestMap.id);
    expect(fetched?.id).toBe(sampleApplicationTestMap.id);
    expect(fetched?.areas.length).toBe(sampleApplicationTestMap.areas.length);
  });

  it("returns undefined for an unknown map id", () => {
    expect(repository.get("unknown-map-id")).toBeUndefined();
  });

  it("lists every saved map", () => {
    expect(repository.list().map((map) => map.id)).toContain(sampleApplicationTestMap.id);
  });
});
