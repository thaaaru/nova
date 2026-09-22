import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { IdentificationArtifact } from "../../domain/index.js";
import { IdentificationArtifactSchema } from "../../domain/index.js";

/**
 * Caches a validated identification against the sanitized evidence hash,
 * so resuming an interrupted workflow — or re-running discovery that
 * produced an identical evidence package — never pays for the same model
 * call twice. The key includes provider/model/prompt version: changing
 * any of them is a different question, not a cache hit.
 *
 * Only the validated artifact is stored. The prompt text, the raw model
 * response, and the evidence contents are not written here.
 */
export type IdentificationCache = {
  get(key: string): IdentificationArtifact | undefined;
  set(key: string, artifact: IdentificationArtifact): void;
};

export function identificationCacheKey(parts: {
  provider: string;
  model: string;
  promptVersion: string;
  evidenceHash: string;
}): string {
  return `${parts.provider}|${parts.model}|${parts.promptVersion}|${parts.evidenceHash}`;
}

/** One JSON file per key under `<dataDir>/identification-cache`. No database needed for a write-once, read-often lookup. */
export function createFileIdentificationCache(directory: string): IdentificationCache {
  const safeName = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    get(key) {
      const path = join(directory, `${safeName(key)}.json`);
      if (!existsSync(path)) {
        return undefined;
      }
      try {
        return IdentificationArtifactSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        // A corrupt or stale-shaped cache entry is simply a miss.
        return undefined;
      }
    },
    set(key, artifact) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${safeName(key)}.json`), JSON.stringify(artifact, null, 2));
    },
  };
}

/** Used by tests and by any run that should not touch disk. */
export function createMemoryIdentificationCache(): IdentificationCache {
  const store = new Map<string, IdentificationArtifact>();
  return {
    get: (key) => store.get(key),
    set: (key, artifact) => void store.set(key, artifact),
  };
}
