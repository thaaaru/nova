import { join } from "node:path";

/** Every persisted artifact for a run lives under `<artifactsDirectory>/<runId>`. */
export function runArtifactsDirectory(artifactsDirectory: string, runId: string): string {
  return join(artifactsDirectory, runId);
}

/**
 * Screenshot filename for a discovered route path. `taken` disambiguates
 * routes that slug identically (`/a/b` and `/a-b`); names only need to be
 * unique within one phase directory, so discovery and execution each keep
 * their own set.
 */
export function screenshotFileName(path: string, taken: ReadonlySet<string> = new Set()): string {
  const slug =
    path === "/" ? "home" : path.replaceAll(/^\/+|\/+$/g, "").replaceAll(/[^a-z0-9]+/gi, "-") || "page";
  let name = `${slug}.png`;
  for (let index = 2; taken.has(name); index += 1) {
    name = `${slug}-${index}.png`;
  }
  return name;
}
