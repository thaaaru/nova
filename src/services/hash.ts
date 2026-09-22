import { createHash } from "node:crypto";

/**
 * Deterministic JSON canonicalization: object keys sorted recursively,
 * `undefined` dropped, arrays left in order. Two structurally identical
 * values always produce the same string regardless of key insertion
 * order, so a hash over it is stable across processes and machines.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

/** sha256 of the canonical form — the single hashing primitive for plan hashes, evidence hashes, and idempotency keys. */
export function sha256Of(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
