import { execFileSync } from "node:child_process";

export type ApplyUpdateOptions = {
  repoDir: string;
  /** Discards uncommitted changes and diverged local commits, resetting hard to origin/main. */
  force?: boolean;
  /** Skips `pnpm install`/`pnpm build` after a successful sync — tests only; the real CLI always runs them. */
  skipInstallBuild?: boolean;
  onProgress?: (message: string) => void;
};

export type ApplyUpdateResult = { updated: boolean; fromCommit: string; toCommit: string };

export class DirtyWorkingTreeError extends Error {}
export class DivergedHistoryError extends Error {}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * `nova update`'s implementation: force-checks GitHub right now (instead
 * of waiting for the next 15-minutes-later invocation) and actually
 * applies whatever it finds — fetch, fast-forward (or `--force` hard
 * reset), reinstall, rebuild. A dirty working tree or a diverged local
 * history both refuse by default rather than silently discarding an
 * operator's own commits; `--force` is the explicit override for both.
 */
export async function applyUpdate(options: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  const log = options.onProgress ?? (() => undefined);
  const { repoDir, force = false } = options;

  const fromCommit = run("git", ["rev-parse", "HEAD"], repoDir).trim();

  if (!force) {
    const status = run("git", ["status", "--porcelain"], repoDir);
    if (status.trim().length > 0) {
      throw new DirtyWorkingTreeError(
        "Working tree has uncommitted changes. Commit or stash them first, or re-run `nova update --force` to discard them.",
      );
    }
  }

  log("Fetching latest from origin...");
  run("git", ["fetch", "origin", "main"], repoDir);

  if (force) {
    log("Resetting to origin/main (--force: discarding local changes)...");
    run("git", ["reset", "--hard", "origin/main"], repoDir);
  } else {
    log("Fast-forwarding to origin/main...");
    try {
      run("git", ["merge", "--ff-only", "origin/main"], repoDir);
    } catch {
      throw new DivergedHistoryError(
        "Local main has diverged from origin/main and cannot fast-forward. Re-run `nova update --force` to discard local commits, or resolve manually.",
      );
    }
  }

  const toCommit = run("git", ["rev-parse", "HEAD"], repoDir).trim();
  if (toCommit === fromCommit) {
    log("Already up to date.");
    return { updated: false, fromCommit, toCommit };
  }

  if (!options.skipInstallBuild) {
    log("Installing dependencies...");
    run("pnpm", ["install", "--frozen-lockfile"], repoDir);
    log("Rebuilding...");
    run("pnpm", ["build"], repoDir);
  }

  return { updated: true, fromCommit, toCommit };
}
