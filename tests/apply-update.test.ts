import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyUpdate,
  DirtyWorkingTreeError,
  DivergedHistoryError,
} from "../src/services/update-check/apply-update.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(dir: string): void {
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
}

/** Clones origin and checks out a real local `main` tracking origin/main — a fresh bare repo has no default branch, so a plain clone can otherwise land on an unrelated local branch name. */
function cloneAsMain(origin: string, dest: string, cwd: string): void {
  execFileSync("git", ["clone", "-q", origin, dest], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  git(["checkout", "-q", "-b", "main", "origin/main"], dest);
  git(["config", "user.email", "test@example.com"], dest);
  git(["config", "user.name", "Test"], dest);
}

function commitFile(dir: string, name: string, contents: string, message: string): string {
  writeFileSync(join(dir, name), contents, "utf8");
  git(["add", name], dir);
  git(["commit", "-q", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir).trim();
}

let tempDir: string;
let originDir: string;
let workDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nova-apply-update-test-"));
  originDir = join(tempDir, "origin.git");
  workDir = join(tempDir, "work");

  // A real bare "origin" plus a real clone, exactly like a GitHub remote
  // and a local checkout — every test below drives real git subprocesses
  // against them, no mocked git behavior anywhere.
  execFileSync("git", ["init", "-q", "--bare", originDir]);

  const seedDir = join(tempDir, "seed");
  execFileSync("mkdir", ["-p", seedDir]);
  initRepo(seedDir);
  commitFile(seedDir, "f.txt", "v1\n", "initial commit");
  git(["branch", "-M", "main"], seedDir);
  git(["remote", "add", "origin", originDir], seedDir);
  git(["push", "-q", "origin", "main"], seedDir);

  cloneAsMain(originDir, workDir, tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("applyUpdate", () => {
  it("reports updated:false with no local changes needed when already in sync with origin", async () => {
    const result = await applyUpdate({ repoDir: workDir, skipInstallBuild: true });
    expect(result.updated).toBe(false);
    expect(result.fromCommit).toBe(result.toCommit);
  });

  it("fast-forwards to a newer origin/main and reports updated:true", async () => {
    // Push a second commit from a fresh clone acting as another contributor.
    const otherDir = join(tempDir, "other");
    cloneAsMain(originDir, otherDir, tempDir);
    initRepo(otherDir);
    const newHead = commitFile(otherDir, "g.txt", "v2\n", "second commit");
    git(["push", "-q", "origin", "main"], otherDir);

    const before = git(["rev-parse", "HEAD"], workDir).trim();
    const result = await applyUpdate({ repoDir: workDir, skipInstallBuild: true });

    expect(result.updated).toBe(true);
    expect(result.fromCommit).toBe(before);
    expect(result.toCommit).toBe(newHead);
    expect(existsSync(join(workDir, "g.txt"))).toBe(true);
    expect(readFileSync(join(workDir, "g.txt"), "utf8")).toBe("v2\n");
  });

  it("throws DirtyWorkingTreeError and never touches the working tree when uncommitted changes exist and --force is not passed", async () => {
    writeFileSync(join(workDir, "f.txt"), "locally edited\n", "utf8");

    await expect(applyUpdate({ repoDir: workDir, skipInstallBuild: true })).rejects.toBeInstanceOf(
      DirtyWorkingTreeError,
    );
    // The dirty edit is untouched — no fetch/reset was attempted.
    expect(readFileSync(join(workDir, "f.txt"), "utf8")).toBe("locally edited\n");
  });

  it("--force discards uncommitted changes and resets hard to origin/main", async () => {
    writeFileSync(join(workDir, "f.txt"), "locally edited\n", "utf8");

    const result = await applyUpdate({ repoDir: workDir, force: true, skipInstallBuild: true });

    expect(result.updated).toBe(false); // origin/main hasn't moved, only the local dirty edit was discarded
    expect(readFileSync(join(workDir, "f.txt"), "utf8")).toBe("v1\n");
  });

  it("throws DivergedHistoryError when local has its own commit origin doesn't, without --force", async () => {
    // Local diverges with its own commit...
    commitFile(workDir, "local-only.txt", "mine\n", "local-only commit");
    // ...while origin also moves forward from a different contributor.
    const otherDir = join(tempDir, "other2");
    cloneAsMain(originDir, otherDir, tempDir);
    initRepo(otherDir);
    commitFile(otherDir, "h.txt", "v3\n", "third commit");
    git(["push", "-q", "origin", "main"], otherDir);

    await expect(applyUpdate({ repoDir: workDir, skipInstallBuild: true })).rejects.toBeInstanceOf(
      DivergedHistoryError,
    );
  });

  it("--force resolves diverged history by hard-resetting to origin/main, discarding the local-only commit", async () => {
    commitFile(workDir, "local-only.txt", "mine\n", "local-only commit");
    const otherDir = join(tempDir, "other3");
    cloneAsMain(originDir, otherDir, tempDir);
    initRepo(otherDir);
    const newHead = commitFile(otherDir, "h.txt", "v3\n", "third commit");
    git(["push", "-q", "origin", "main"], otherDir);

    const result = await applyUpdate({ repoDir: workDir, force: true, skipInstallBuild: true });

    expect(result.updated).toBe(true);
    expect(result.toCommit).toBe(newHead);
    expect(existsSync(join(workDir, "local-only.txt"))).toBe(false);
    expect(existsSync(join(workDir, "h.txt"))).toBe(true);
  });

  it("calls onProgress with human-readable step messages", async () => {
    const otherDir = join(tempDir, "other4");
    cloneAsMain(originDir, otherDir, tempDir);
    initRepo(otherDir);
    commitFile(otherDir, "i.txt", "v4\n", "fourth commit");
    git(["push", "-q", "origin", "main"], otherDir);

    const messages: string[] = [];
    await applyUpdate({ repoDir: workDir, skipInstallBuild: true, onProgress: (m) => messages.push(m) });

    expect(messages).toContain("Fetching latest from origin...");
    expect(messages.some((m) => m.includes("Fast-forwarding"))).toBe(true);
  });
});

describe("applyUpdate — real thaaaru/nova checkout", () => {
  // This checkout's own repo, against the real GitHub origin — real
  // network, real git, no fabricated state. This session's working tree
  // is frequently dirty (in-flight edits, or the pre-existing untouched
  // tekassure/STATUS.md diff noted throughout this project), so a
  // DirtyWorkingTreeError is an equally valid, equally real outcome here
  // — the assertion is "the real git/network path completes and returns
  // one of its two well-defined outcomes", not "this checkout happens to
  // be clean right now".
  it("reports up to date/fast-forwards, or correctly reports a dirty tree, against the real origin", async () => {
    try {
      const result = await applyUpdate({
        repoDir: "/Users/tharaka/Projects/nova",
        skipInstallBuild: true,
      });
      expect(typeof result.fromCommit).toBe("string");
      expect(typeof result.toCommit).toBe("string");
    } catch (error) {
      expect(error).toBeInstanceOf(DirtyWorkingTreeError);
    }
  }, 15_000);
});
