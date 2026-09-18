import { spawn } from "node:child_process";

/**
 * Best-effort OS-opener shell-out (macOS `open`, Linux `xdg-open`). Always
 * guarded: a headless CI box or a container with no GUI opener installed
 * must not crash the TUI — the caller always prints the path too, so the
 * operator is never stuck without it.
 */
export function openPathWithOsOpener(path: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(opener, [path], { stdio: "ignore", detached: true }).unref();
  } catch {
    // No GUI opener available; the caller has already printed `path`.
  }
}
