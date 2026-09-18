// A throwaway copy of this checkout as a git repo on `main` with a bare
// `origin`, for setup.sh --all / validate.sh tests: the live worktree they
// create attaches to the fixture, never to this repo, and never to ~/.pi.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const REPO = join(import.meta.dirname, "..");

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
}

export function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pawprint-fx-"));
  const repo = join(dir, "repo");
  // .git of a linked worktree is a pointer FILE into the real repo; never copy it.
  cpSync(REPO, repo, { recursive: true, filter: (src) => ![".git", ".pi-types", "node_modules"].includes(basename(src)) });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");   // the copied default-deny .gitignore decides what is tracked
  git(repo, "commit", "-q", "--no-verify", "-m", "fixture");
  execFileSync("git", ["clone", "-q", "--bare", repo, join(dir, "origin.git")]);
  git(repo, "remote", "add", "origin", join(dir, "origin.git"));
  git(repo, "fetch", "-q");
  git(repo, "branch", "-q", "-u", "origin/main", "main");
  return repo;
}

/** setup.sh --all --config-only from `repo` onto `<live>/agent`; returns the spawn result. */
export function setupAll(repo: string, live: string, extra: string[] = [], env = process.env) {
  return spawnSync("bash", [join(repo, "setup.sh"), "--all", "--config-only", "--target", join(live, "agent"), ...extra], { encoding: "utf8", env });
}
