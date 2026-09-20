import { importSPKI, jwtVerify } from "jose";
import { z } from "zod";

export class LicenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LicenseError";
  }
}

const LicensePayloadSchema = z.object({
  licenseId: z.string().min(1),
  orgId: z.string().min(1),
  brandId: z.string().min(1).optional(),
  features: z.array(z.string()).default([]),
  seats: z.number().int().min(1).default(1),
});
export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

// Tolerate device clock drift around the signed exp/nbf; there is no server to re-check against.
const CLOCK_TOLERANCE_SECONDS = 24 * 60 * 60;

export async function verifyLicenseToken(token: string, publicKeyPem?: string): Promise<LicensePayload> {
  const pem = publicKeyPem ?? process.env.NOVA_LICENSE_PUBLIC_KEY;
  if (!pem) {
    throw new LicenseError("No Nova license public key configured (NOVA_LICENSE_PUBLIC_KEY).");
  }

  const key = await importSPKI(pem, "ES256").catch(() => {
    throw new LicenseError("Nova license public key is malformed.");
  });

  try {
    const { payload } = await jwtVerify(token, key, { clockTolerance: CLOCK_TOLERANCE_SECONDS });
    return LicensePayloadSchema.parse(payload);
  } catch (error) {
    if (error instanceof LicenseError) {
      throw error;
    }
    throw new LicenseError(`License verification failed: ${(error as Error).message}`);
  }
}
