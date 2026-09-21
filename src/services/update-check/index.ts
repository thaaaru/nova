import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const BREAK_THRESHOLD_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;
const GITHUB_REPO = "thaaaru/nova";

type UpdateCheckState = { lastRunAt?: string };

function stateFilePath(databasePath: string): string {
  return join(dirname(databasePath), ".nova-update-check.json");
}

function readState(path: string): UpdateCheckState {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UpdateCheckState;
  } catch {
    return {};
  }
}

function writeState(path: string, state: UpdateCheckState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    // Best-effort only — an unwritable state file just means every future
    // invocation looks like a fresh "after a break" check, never a crash.
  }
}

function localHeadCommit(repoDir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export type UpdateCheckOptions = {
  /** Same database path already resolved by config — its directory holds the small last-run marker file. */
  databasePath: string;
  /** Defaults to process.cwd(); override in tests to point at a fixture checkout. */
  repoDir?: string;
  /** Defaults to Date.now; override in tests for deterministic elapsed-time control. */
  now?: () => number;
  /** Defaults to the global fetch; override in tests to simulate offline/error/stale responses without a real network call. */
  fetchImpl?: typeof fetch;
};

/**
 * Nova never phones home on its own schedule. This only ever reaches
 * GitHub's public, unauthenticated commit API, and only when the operator
 * is sitting back down after a real gap — more than 15 minutes since the
 * last `nova` invocation — never on every single command. A first-ever
 * invocation (no prior marker) also counts as due, so a fresh install
 * gets one immediate check.
 *
 * Every failure mode — offline, GitHub unreachable, rate-limited, not a
 * git checkout, an unwritable state file — is swallowed and returns
 * `undefined`: a missed or failed check must never block, slow past its
 * own timeout, or fail the command that triggered it.
 */
export async function checkForUpdatesIfDue(options: UpdateCheckOptions): Promise<string | undefined> {
  if (process.env.CI || process.env.NOVA_NO_UPDATE_CHECK) {
    return undefined;
  }

  const now = options.now ?? Date.now;
  const nowMs = now();
  const path = stateFilePath(options.databasePath);
  const state = readState(path);
  const lastRunAt = state.lastRunAt ? Date.parse(state.lastRunAt) : undefined;
  const dueForCheck =
    lastRunAt === undefined || Number.isNaN(lastRunAt) || nowMs - lastRunAt > BREAK_THRESHOLD_MS;

  writeState(path, { lastRunAt: new Date(nowMs).toISOString() });

  if (!dueForCheck) {
    return undefined;
  }

  const repoDir = options.repoDir ?? process.cwd();
  const local = localHeadCommit(repoDir);
  if (!local) {
    return undefined;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}/commits/main`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { sha?: string };
    if (!body.sha || body.sha === local) {
      return undefined;
    }
    return (
      `Nova has been updated on GitHub (${local.slice(0, 7)} -> ${body.sha.slice(0, 7)}). ` +
      "Run `git pull && ./install.sh` to update."
    );
  } catch {
    return undefined;
  }
}
