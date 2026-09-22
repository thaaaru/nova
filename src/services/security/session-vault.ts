import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Nova's local session-material vault. A Playwright login capture
 * (see `services/browser/login.ts`'s `captureStorageState`) briefly
 * holds cookies/localStorage in plaintext inside a headed browser
 * session; this vault encrypts that storageState immediately
 * afterward with AES-256-GCM before anything touches disk. Captured
 * session material never touches model context and is never persisted
 * in plaintext — only the resulting opaque vault file path (a
 * `vaultRef`) is ever handed back to callers.
 */
export class FileSessionVault {
  private readonly vaultDir: string;
  private key: Buffer | undefined;

  constructor(vaultDir: string) {
    this.vaultDir = vaultDir;
  }

  private ensureKey(): Buffer {
    if (this.key) {
      return this.key;
    }
    mkdirSync(this.vaultDir, { recursive: true });
    const keyPath = join(this.vaultDir, "vault.key");
    if (existsSync(keyPath)) {
      this.key = readFileSync(keyPath);
      return this.key;
    }
    const key = randomBytes(32);
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);
    this.key = key;
    return key;
  }

  encrypt(data: unknown): string {
    const key = this.ensureKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
    const filePath = join(this.vaultDir, `${randomUUID()}.session`);
    writeFileSync(filePath, payload);
    chmodSync(filePath, 0o600);
    return filePath;
  }

  decrypt(vaultRef: string): unknown {
    const key = this.ensureKey();
    const payload = readFileSync(vaultRef, "utf8");
    const [ivB64, authTagB64, ciphertextB64] = payload.split(":");
    if (!ivB64 || !authTagB64 || !ciphertextB64) {
      throw new Error(`Malformed session vault payload at ${vaultRef}`);
    }
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const ciphertext = Buffer.from(ciphertextB64, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  }

  delete(vaultRef: string): void {
    rmSync(vaultRef, { force: true });
  }
}

/**
 * A captured Playwright storageState's cookies, as far as this check
 * needs them: only the `expires` field (Unix seconds; `-1` means a
 * session-only cookie with no expiry, per Playwright convention).
 */
export interface SessionLike {
  cookies?: Array<{ expires?: number }>;
}

/**
 * True only when a session is definitively unusable: at least one
 * cookie has a concrete expiry timestamp that has already passed, and
 * no cookie remains that is still valid (a future expiry, no expiry
 * field, or Playwright's `-1` "session cookie" sentinel). A session
 * with no cookies, or no cookies carrying a numeric `expires`, is never
 * reported as expired — there's nothing conclusive to go on.
 */
export function isSessionLikelyExpired(session: SessionLike): boolean {
  const cookies = session.cookies ?? [];
  const now = Date.now();

  const hasDefinitelyExpiredCookie = cookies.some(
    (cookie) => typeof cookie.expires === "number" && cookie.expires !== -1 && cookie.expires * 1000 < now,
  );
  if (!hasDefinitelyExpiredCookie) {
    return false;
  }

  const hasStillValidCookie = cookies.some((cookie) => {
    if (cookie.expires === undefined || cookie.expires === -1) {
      return true;
    }
    return cookie.expires * 1000 >= now;
  });

  return !hasStillValidCookie;
}
