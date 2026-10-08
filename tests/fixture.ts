// A throwaway copy of this checkout as a git repo on `main` with a bare
// `origin`, for setup.sh --all / validate.sh tests: the live dir they create
// is a plain directory — never a worktree, never ~/.pi. All scratch lives in
// git-ignored `.setup-scratch-*` dirs under this checkout (never /tmp, so test
// fixtures never leave the task worktree) and is removed at process exit.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

export const REPO = join(import.meta.dirname, "..");

const made: string[] = [];
process.on("exit", () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** mkdtemp under the checkout (git-ignored by the default-deny policy). */
export function mktmp(prefix: string): string {
  const dir = mkdtempSync(join(REPO, `.setup-scratch-${prefix}-`));
  made.push(dir);
  return dir;
}

// maintenance.auto=false: git ≥ 2.54 detaches `maintenance run --auto` after a
// commit, which packs the loose objects while `clone --bare` is still copying them.
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "maintenance.auto=false", ...args], { encoding: "utf8" }).trim();
}

export function fixtureRepo(): string {
  const dir = mktmp("fx");
  const repo = join(dir, "repo");
  // .git of a linked worktree is a pointer FILE into the real repo; never copy it.
  // .cmp-scratch / .setup-scratch: in-worktree test scratch. It appears and
  // vanishes while a parallel test file's copy is walking the repo — never copy it.
  // Entry-by-entry because scratch lives INSIDE REPO: cpSync(REPO, …) would be
  // a copy of a directory into its own subdirectory, which node refuses.
  mkdirSync(repo, { recursive: true });
  for (const entry of readdirSync(REPO)) {
    if ([".git", ".pi-types", "node_modules", ".cmp-scratch"].includes(entry) || entry.startsWith(".setup-scratch")) continue;
    cpSync(join(REPO, entry), join(repo, entry), { recursive: true });
  }
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");   // the copied default-deny .gitignore decides what is tracked
  git(repo, "commit", "-q", "--no-verify", "-m", "fixture");
  execFileSync("git", ["clone", "-q", "--bare", repo, join(dir, "origin.git")]);
  git(repo, "remote", "add", "origin", join(dir, "origin.git"));
  git(repo, "fetch", "-q");
  git(repo, "branch", "-q", "-u", "origin/main", "main");
  return repo;
}

let piPkg: string | undefined;
/** The mise-installed pi package dir, resolved once with the test's own real PATH. */
export function piPackageDir(): string {
  return (piPkg ??= `${execFileSync("mise", ["where", "npm:@earendil-works/pi-coding-agent"], { encoding: "utf8" }).trim()}/node_modules/@earendil-works/pi-coding-agent`);
}

/** setup.sh --all --config-only from `repo` onto `<live>/agent`; returns the spawn result. */
export function setupAll(repo: string, live: string, extra: string[] = [], env = process.env) {
  // PAWPRINT_PI_PKG: a PATH-stubbed `mise` (machinery tests) must not break the
  // settings writer's pi-package resolution.
  return spawnSync("bash", [join(repo, "setup.sh"), "--all", "--config-only", "--target", join(live, "agent"), ...extra], {
    encoding: "utf8",
    env: { ...env, PAWPRINT_PI_PKG: piPackageDir() },
  });
}
