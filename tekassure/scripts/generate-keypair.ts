#!/usr/bin/env -S tsx
// Run once to generate the ES256 keypair used to sign/verify license
// tokens. Keep the private key offline (only you use it, in
// scripts/issue-license.ts); ship the public key to customers as
// NOVA_LICENSE_PUBLIC_KEY.

import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });

console.log("# NOVA_SIGNING_PRIVATE_KEY (keep secret, use only with scripts/issue-license.ts)");
console.log(await exportPKCS8(privateKey));
console.log("# NOVA_LICENSE_PUBLIC_KEY (ship to customers so `nova license activate` can verify offline)");
console.log(await exportSPKI(publicKey));
