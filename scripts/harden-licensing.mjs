#!/usr/bin/env node
// Post-build hardening for the license enforcement gate.
//
// Runs after `tsc` on the already-compiled dist/licensing/activate.js:
//   1. Compile-time removes the NOVA_SKIP_LICENSE dev/CI escape hatch. It is
//      real and needed while iterating locally (via `tsx`/`vitest` against
//      src/*.ts), but it must never ship in the published npm package --
//      readable dist output would make it a one-line, undocumented license
//      bypass for anyone who unpacks the tarball. esbuild's `define` swaps
//      the env lookup for a literal that can never equal "1", then `minify`
//      dead-code-eliminates the now-unreachable branch entirely.
//   2. Obfuscates what's left (control-flow flattening, string-array
//      encoding, dead-code injection) so the compiled gate isn't a trivial
//      read-and-patch target either.
//
// verify-license.ts is intentionally left alone: it is generic JWT
// verification with no bypass logic, `LicenseError` class identity across it
// and cli.ts/activate.js must be preserved (obfuscating in a separate build
// step would otherwise produce a second, distinct class), and there is
// little marginal protection in obscuring a standard jose call.
import { build } from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";
import { readFileSync, writeFileSync } from "node:fs";

const target = "dist/licensing/activate.js";

const bundled = await build({
  entryPoints: [target],
  outfile: target,
  allowOverwrite: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  external: ["./verify-license.js"],
  define: {
    "process.env.NOVA_SKIP_LICENSE": '"__disabled_in_published_build__"',
  },
  write: true,
});
if (bundled.errors.length > 0) {
  console.error(bundled.errors);
  process.exit(1);
}

const compiled = readFileSync(target, "utf8");
if (compiled.includes("NOVA_SKIP_LICENSE")) {
  throw new Error("harden-licensing: NOVA_SKIP_LICENSE survived dead-code elimination -- refusing to ship.");
}

const obfuscated = JavaScriptObfuscator.obfuscate(compiled, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 1,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  stringArray: true,
  stringArrayEncoding: ["rc4"],
  stringArrayThreshold: 1,
  identifierNamesGenerator: "mangled",
  renameGlobals: false,
  selfDefending: false, // selfDefending's re-formatting detection is fragile under further minification/packaging; skip it.
}).getObfuscatedCode();

writeFileSync(target, obfuscated);
console.log(`harden-licensing: rebuilt and obfuscated ${target}`);
