import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { NovaRuntime } from "../../cli/context.js";
import type { ProjectPersona, PersonaSessionStatus } from "../../domain/index.js";
import { captureStorageState } from "../browser/login.js";
import { FileSessionVault, isSessionLikelyExpired, type SessionLike } from "../security/session-vault.js";

/**
 * The project-level "test persona" service — a QA engineer's reusable
 * named identity (e.g. "QA Admin", "Standard Customer") scoped to one
 * Project, so the same signed-in session can be reused across every
 * Application Test Map inside that project instead of re-authenticating
 * per app. This is the layer that hides session/cookie/vault mechanics
 * from every caller above it (the TUI, the CLI): everything outside this
 * file only ever sees a persona id, a name, and a `PersonaSessionStatus`
 * ("ready" | "expired" | "needs_login") — never a path, a cookie, or a
 * vault reference.
 */

export type PersonaView = {
  id: string;
  name: string;
  method: ProjectPersona["method"];
  sessionStatus: PersonaSessionStatus;
};

function vault(runtime: NovaRuntime): FileSessionVault {
  return new FileSessionVault(runtime.sessionVaultDir);
}

function toView(persona: ProjectPersona): PersonaView {
  return { id: persona.id, name: persona.name, method: persona.method, sessionStatus: persona.sessionStatus };
}

/**
 * Re-derives a `browser_login` persona's session status from the actual
 * vaulted session's cookie expiries (never trusts a stale stored value),
 * persisting the recomputed status. `external_reference` personas have
 * no session material Nova can verify, so their stored status is left
 * exactly as the operator last set it.
 */
function refreshPersonaStatus(runtime: NovaRuntime, persona: ProjectPersona): ProjectPersona {
  if (persona.method !== "browser_login" || !persona.vaultRef) {
    return persona;
  }
  let session: SessionLike;
  try {
    session = vault(runtime).decrypt(persona.vaultRef) as SessionLike;
  } catch {
    // Vault file missing/corrupted — treat as needing a fresh sign-in
    // rather than throwing out of a list/read path.
    const updated: ProjectPersona = { ...persona, sessionStatus: "needs_login" };
    runtime.personas.save(updated);
    return updated;
  }
  const nextStatus: PersonaSessionStatus = isSessionLikelyExpired(session) ? "expired" : "ready";
  if (nextStatus === persona.sessionStatus) {
    return persona;
  }
  const updated: ProjectPersona = { ...persona, sessionStatus: nextStatus, updatedAt: new Date().toISOString() };
  runtime.personas.save(updated);
  return updated;
}

export function listPersonas(runtime: NovaRuntime, projectId: string): PersonaView[] {
  return runtime.personas.list(projectId).map((persona) => toView(refreshPersonaStatus(runtime, persona)));
}

export function getPersona(runtime: NovaRuntime, personaId: string): PersonaView | undefined {
  const persona = runtime.personas.get(personaId);
  return persona ? toView(refreshPersonaStatus(runtime, persona)) : undefined;
}

/**
 * Decrypts a `browser_login` persona's vaulted session into a local,
 * working session-state file a Playwright browser context can consume
 * directly (`storageStatePath`), chmod 600, co-located with every other
 * session file Nova writes. Regenerated fresh from the encrypted vault
 * every time it's needed rather than kept around — the only plaintext
 * copy that ever exists is this one short-lived, file-permission-locked
 * working copy, exactly the same trust model the existing "sign in now"
 * capture already used before personas existed.
 */
export function resolvePersonaStorageStatePath(runtime: NovaRuntime, personaId: string): string | undefined {
  const persona = runtime.personas.get(personaId);
  if (!persona || persona.method !== "browser_login" || !persona.vaultRef) {
    return undefined;
  }
  const session = vault(runtime).decrypt(persona.vaultRef);
  const outputPath = join(dirname(runtime.config.databasePath), "sessions", `persona-${persona.id}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(session));
  chmodSync(outputPath, 0o600);
  return outputPath;
}

export type CreatePersonaFromLoginOptions = {
  projectId: string;
  name: string;
  url: string;
  /** Blocks until the operator confirms they've finished signing in — same contract as `captureStorageState`. */
  waitForOperator: () => Promise<void>;
  headless?: boolean;
};

/**
 * Opens a real headed browser, lets the operator sign in by hand (via
 * `captureStorageState`), then immediately encrypts the captured session
 * into the vault and deletes the plaintext capture file — the only
 * moment session material exists in plaintext on disk is the brief
 * window `captureStorageState` itself writes to a throwaway temp path.
 */
export async function createPersonaFromLogin(
  runtime: NovaRuntime,
  options: CreatePersonaFromLoginOptions,
): Promise<{ persona: ProjectPersona; storageStatePath: string }> {
  const tempPath = join(dirname(runtime.config.databasePath), "sessions", `tmp-${randomUUID()}.json`);
  await captureStorageState({
    url: options.url,
    outputPath: tempPath,
    waitForOperator: options.waitForOperator,
  });
  const sessionJson = JSON.parse(readFileSync(tempPath, "utf8"));
  rmSync(tempPath, { force: true });

  const vaultRef = vault(runtime).encrypt(sessionJson);
  const now = new Date().toISOString();
  const persona: ProjectPersona = {
    id: randomUUID(),
    projectId: options.projectId,
    name: options.name,
    method: "browser_login",
    sessionStatus: "ready",
    vaultRef,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
  };
  runtime.personas.save(persona);
  const storageStatePath = resolvePersonaStorageStatePath(runtime, persona.id);
  if (!storageStatePath) {
    throw new Error("Failed to resolve the just-captured persona session.");
  }
  return { persona, storageStatePath };
}

export type ReconnectPersonaOptions = {
  personaId: string;
  url: string;
  waitForOperator: () => Promise<void>;
  headless?: boolean;
};

/**
 * Re-captures a `browser_login` persona's session (its saved one is
 * expired or was never captured) and overwrites the vault entry in
 * place — same persona identity, fresh session material.
 */
export async function reconnectPersona(
  runtime: NovaRuntime,
  options: ReconnectPersonaOptions,
): Promise<{ persona: ProjectPersona; storageStatePath: string }> {
  const existing = runtime.personas.get(options.personaId);
  if (!existing) {
    throw new Error(`Unknown persona: ${options.personaId}`);
  }
  const tempPath = join(dirname(runtime.config.databasePath), "sessions", `tmp-${randomUUID()}.json`);
  await captureStorageState({
    url: options.url,
    outputPath: tempPath,
    waitForOperator: options.waitForOperator,
  });
  const sessionJson = JSON.parse(readFileSync(tempPath, "utf8"));
  rmSync(tempPath, { force: true });

  if (existing.vaultRef && existsSync(existing.vaultRef)) {
    vault(runtime).delete(existing.vaultRef);
  }
  const vaultRef = vault(runtime).encrypt(sessionJson);
  const now = new Date().toISOString();
  const persona: ProjectPersona = {
    ...existing,
    method: "browser_login",
    sessionStatus: "ready",
    vaultRef,
    updatedAt: now,
    lastVerifiedAt: now,
  };
  runtime.personas.save(persona);
  const storageStatePath = resolvePersonaStorageStatePath(runtime, persona.id);
  if (!storageStatePath) {
    throw new Error("Failed to resolve the just-reconnected persona session.");
  }
  return { persona, storageStatePath };
}

/**
 * Records a persona backed by an operator-managed test account outside
 * Nova (a name/note, never a credential Nova itself holds or uses) —
 * for QA orgs whose account provisioning Nova has no automated way to
 * drive. Discovery/execution against this persona proceeds without a
 * captured session (public-area-only) until the operator reconnects it
 * with a real sign-in.
 */
export function createPersonaFromReference(
  runtime: NovaRuntime,
  options: { projectId: string; name: string; reference: string },
): ProjectPersona {
  const now = new Date().toISOString();
  const persona: ProjectPersona = {
    id: randomUUID(),
    projectId: options.projectId,
    name: options.name,
    method: "external_reference",
    sessionStatus: "needs_login",
    reference: options.reference,
    createdAt: now,
    updatedAt: now,
  };
  runtime.personas.save(persona);
  return persona;
}

export function deletePersona(runtime: NovaRuntime, personaId: string): void {
  const persona = runtime.personas.get(personaId);
  if (persona?.vaultRef && existsSync(persona.vaultRef)) {
    vault(runtime).delete(persona.vaultRef);
  }
  runtime.personas.delete(personaId);
}

const STATUS_LABEL: Record<PersonaSessionStatus, string> = {
  ready: "Ready",
  expired: "Expired",
  needs_login: "Needs login",
};

export function personaSessionStatusLabel(status: PersonaSessionStatus): string {
  return STATUS_LABEL[status];
}
