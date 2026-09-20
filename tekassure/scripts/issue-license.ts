#!/usr/bin/env -S tsx
// Operator-only tool: signs a license key offline, no server or database
// involved. Run this on your own machine, keep NOVA_SIGNING_PRIVATE_KEY
// secret, and hand the printed token to the customer for
// `nova license activate <token>`.
//
// Usage:
//   NOVA_SIGNING_PRIVATE_KEY="$(cat signing-key.pem)" \
//     pnpm exec tsx scripts/issue-license.ts "Acme Corp" --seats 5 --days 365
//
// Generate a keypair once with:
//   pnpm exec tsx scripts/generate-keypair.ts
// then keep NOVA_SIGNING_PRIVATE_KEY offline and ship
// NOVA_SIGNING_PUBLIC_KEY to customers as NOVA_LICENSE_PUBLIC_KEY.

import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";

type Args = {
  orgName: string;
  seats: number;
  days: number;
  features: string[];
};

function parseArgs(argv: string[]): Args {
  const [orgName, ...rest] = argv;
  if (!orgName) {
    console.error("Usage: tsx scripts/issue-license.ts <org-name> [--seats N] [--days N] [--features a,b,c]");
    process.exit(1);
  }

  let seats = 1;
  let days = 365;
  let features = ["discover", "execute"];
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--seats") seats = Number.parseInt(value, 10);
    else if (flag === "--days") days = Number.parseInt(value, 10);
    else if (flag === "--features") features = value.split(",").map((f) => f.trim());
    else {
      console.error(`Unknown flag: ${flag}`);
      process.exit(1);
    }
  }
  return { orgName, seats, days, features };
}

async function main(): Promise<void> {
  const pem = process.env.NOVA_SIGNING_PRIVATE_KEY;
  if (!pem) {
    throw new Error(
      "NOVA_SIGNING_PRIVATE_KEY is required. Generate a keypair with " +
        "`pnpm exec tsx scripts/generate-keypair.ts` and set this to the private key PEM.",
    );
  }

  const { orgName, seats, days, features } = parseArgs(process.argv.slice(2));
  const key = await importPKCS8(pem.replace(/\\n/g, "\n"), "ES256");

  const licenseId = randomUUID();
  const orgId = randomUUID();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const token = await new SignJWT({ licenseId, orgId, seats, features })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key);

  console.log(
    JSON.stringify(
      { orgName, licenseId, orgId, seats, features, expiresAt: expiresAt.toISOString(), token },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
