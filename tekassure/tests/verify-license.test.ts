import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { LicenseError, verifyLicenseToken } from "../src/licensing/verify-license.js";

describe("license verification", () => {
  let publicKeyPem: string;
  let privateKey: CryptoKey;
  let otherPublicKeyPem: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    publicKeyPem = await exportSPKI(pair.publicKey);
    privateKey = pair.privateKey;

    const otherPair = await generateKeyPair("ES256", { extractable: true });
    otherPublicKeyPem = await exportSPKI(otherPair.publicKey);
  });

  async function signLicense(overrides: { expiresInSeconds?: number } = {}): Promise<string> {
    const { expiresInSeconds = 3600 } = overrides;
    return new SignJWT({
      licenseId: "lic_123",
      orgId: "org_abc",
      brandId: "brand_teklab",
      features: ["discover", "execute"],
      seats: 5,
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
      .sign(privateKey);
  }

  it("accepts a validly signed, unexpired license", async () => {
    const token = await signLicense();
    const payload = await verifyLicenseToken(token, publicKeyPem);

    expect(payload).toMatchObject({
      licenseId: "lic_123",
      orgId: "org_abc",
      brandId: "brand_teklab",
      features: ["discover", "execute"],
      seats: 5,
    });
  });

  it("rejects a license expired well beyond the clock-skew tolerance", async () => {
    const token = await signLicense({ expiresInSeconds: -25 * 60 * 60 });
    await expect(verifyLicenseToken(token, publicKeyPem)).rejects.toThrow(LicenseError);
  });

  it("tolerates a license that expired within the clock-skew window", async () => {
    const token = await signLicense({ expiresInSeconds: -60 * 60 });
    await expect(verifyLicenseToken(token, publicKeyPem)).resolves.toMatchObject({ licenseId: "lic_123" });
  });

  it("rejects a license signed by an untrusted key", async () => {
    const token = await signLicense();
    await expect(verifyLicenseToken(token, otherPublicKeyPem)).rejects.toThrow(LicenseError);
  });

  it("rejects a tampered token", async () => {
    const token = await signLicense();
    const tampered = `${token.slice(0, -4)}abcd`;
    await expect(verifyLicenseToken(tampered, publicKeyPem)).rejects.toThrow(LicenseError);
  });

  it("requires a configured public key", async () => {
    const token = await signLicense();
    await expect(verifyLicenseToken(token, undefined)).rejects.toThrow(LicenseError);
  });
});
