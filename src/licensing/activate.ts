import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { LicenseError, verifyLicenseToken, type LicensePayload } from "./verify-license.js";

export type StoredLicense = {
  token: string;
  payload: LicensePayload;
  activatedAt: string;
};

function licenseDir(): string {
  return process.env.NOVA_LICENSE_DIR ?? join(homedir(), ".nova");
}

function licensePath(): string {
  return join(licenseDir(), "license.json");
}

/**
 * Activates a license key entirely offline: the token is a self-contained,
 * ES256-signed JWT (see `scripts/issue-license.ts`), so activation is just
 * verifying the signature/expiry locally and writing it to disk. There is
 * no license server to call and no network dependency.
 */
export async function activateLicense(token: string): Promise<StoredLicense> {
  const payload = await verifyLicenseToken(token);

  const stored: StoredLicense = { token, payload, activatedAt: new Date().toISOString() };
  mkdirSync(licenseDir(), { recursive: true });
  writeFileSync(licensePath(), JSON.stringify(stored, null, 2), { mode: 0o600 });
  return stored;
}

export function loadStoredLicense(): StoredLicense | undefined {
  if (!existsSync(licensePath())) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(licensePath(), "utf8")) as StoredLicense;
  } catch (error) {
    throw new LicenseError(
      `Nova license file at ${licensePath()} is corrupt or unreadable (${(error as Error).message}). ` +
        "Run `nova license activate <key>` again to replace it.",
    );
  }
}

export async function requireValidLicense(): Promise<LicensePayload | undefined> {
  if (process.env.NOVA_SKIP_LICENSE === "1") {
    return undefined;
  }

  const stored = loadStoredLicense();
  if (!stored) {
    throw new LicenseError("No Nova license found. Run `nova license activate <key>` first.");
  }
  return verifyLicenseToken(stored.token);
}
