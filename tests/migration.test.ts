// migration.test.ts — retiring the live worktree is a METADATA-ONLY rename of
// the .git gitfile, exercised here on synthetic locked worktrees of fixture
// repos (never ~/.pi). The shell blocks below are the exact commands README.md
// ("Retiring the worktree") documents for the parent — keep them in sync.
// Every block starts with set -e and each precondition is its own simple
// command, so a failed check stops the sequence before the mv.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureRepo, git, mktmp } from "./fixture.ts";

// --- the documented commands (README.md "Retiring the worktree") ------------
const MIGRATE = `set -e
[ -f "$LIVE/.git" ]
[ ! -L "$LIVE/.git" ]
[ "$(git -C "$LIVE" rev-parse --path-format=absolute --git-common-dir)" = "$(git -C "$CLONE" rev-parse --path-format=absolute --git-common-dir)" ]
git -C "$CLONE" worktree list --porcelain | grep -A3 "^worktree $LIVE$" | grep -q '^locked '
[ ! -e "$LIVE/.git-pawprint-retired" ]
[ ! -L "$LIVE/.git-pawprint-retired" ]
mv "$LIVE/.git" "$LIVE/.git-pawprint-retired"
if git -C "$LIVE" status >/dev/null 2>&1; then echo "unexpected: still a repo — stop"; exit 1; fi
`;

const ROLLBACK = `set -e
[ -f "$LIVE/.git-pawprint-retired" ]
[ ! -L "$LIVE/.git-pawprint-retired" ]
[ ! -e "$LIVE/.git" ]
[ ! -L "$LIVE/.git" ]
mv "$LIVE/.git-pawprint-retired" "$LIVE/.git"
git -C "$LIVE" status --porcelain
`;

// Routine source refresh requires the base checkout attached to main.
const REFRESH = `set -e
test "$(git -C "$CLONE" symbolic-ref --quiet HEAD)" = refs/heads/main
git -C "$CLONE" fetch origin main
git -C "$CLONE" merge --ff-only FETCH_HEAD
`;
// ---------------------------------------------------------------------------

const runBlock = (block: string, live: string, clone: string) =>
  spawnSync("bash", ["-c", block], {
    encoding: "utf8",
    // the synthetic live dir sits INSIDE this checkout: without a ceiling git
    // would discover the checkout's own .git above it once the gitfile is gone
    env: { ...process.env, LIVE: live, CLONE: clone, GIT_CEILING_DIRECTORIES: dirname(live) },
  });

function linkedLive(repo: string) {
  // Historical layout before retirement, not today's plain ~/.pi directory:
  // main in the locked live worktree, source clone detached.
  git(repo, "switch", "-q", "--detach");
  const live = join(mktmp("mig"), "pi");
  git(repo, "worktree", "add", "-q", "--lock", "--reason", "live pi config", live, "main");
  writeFileSync(join(live, "agent", "auth.json"), JSON.stringify({ synthetic: "SENTINEL" }));
  mkdirSync(join(live, "agent", "sessions"), { recursive: true });
  writeFileSync(join(live, "agent", "sessions", "s.jsonl"), "{}\n");
  const settingsPath = join(live, "agent", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.lastChangelogVersion = "999.0.0"; // the runtime stamp pi wrote
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return live;
}

test("migration block: guarded rename aside → plain dir, files untouched, locked entry kept; rollback block → worktree again", () => {
  const repo = fixtureRepo();
  const live = linkedLive(repo);
  const sentinel = readFileSync(join(live, "agent", "auth.json"));

  const mig = runBlock(MIGRATE, live, repo);
  assert.equal(mig.status, 0, mig.stderr);
  assert.ok(!existsSync(join(live, ".git")), "gitfile retired");
  assert.ok(lstatSync(join(live, ".git-pawprint-retired")).isFile(), "retired pointer kept");
  assert.deepEqual(readFileSync(join(live, "agent", "auth.json")), sentinel, "credentials untouched");
  assert.ok(existsSync(join(live, "agent", "sessions", "s.jsonl")), "sessions untouched");
  assert.ok(readFileSync(join(live, "agent", "settings.json"), "utf8").includes("999.0.0"), "runtime stamp untouched");

  // the worktree is LOCKED: its admin entry survives even an explicit prune,
  // so rollback never needs a repair
  git(repo, "worktree", "prune", "-v");
  assert.match(git(repo, "worktree", "list", "--porcelain"), new RegExp(`worktree ${live}\\n`), "admin entry kept");

  const back = runBlock(ROLLBACK, live, repo);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(git(live, "branch", "--show-current"), "main");
  assert.match(git(live, "status", "--porcelain"), /(^|\n) ?M agent\/settings\.json/, "the same uncommitted diff as before");
});

test("migration preconditions stop the sequence before the mv", () => {
  // rename target already exists as a directory
  {
    const repo = fixtureRepo();
    const live = linkedLive(repo);
    mkdirSync(join(live, ".git-pawprint-retired"));
    const r = runBlock(MIGRATE, live, repo);
    assert.notEqual(r.status, 0, "must refuse to clobber an existing retired path");
    assert.ok(lstatSync(join(live, ".git")).isFile(), "gitfile never moved");
    assert.deepEqual(readdirSync(join(live, ".git-pawprint-retired")), [], "target untouched");
  }
  // rename target exists as a DANGLING symlink (-e misses it; -L catches it)
  {
    const repo = fixtureRepo();
    const live = linkedLive(repo);
    symlinkSync(join(mktmp("mig"), "nowhere"), join(live, ".git-pawprint-retired"));
    const r = runBlock(MIGRATE, live, repo);
    assert.notEqual(r.status, 0, "dangling symlink at the target must stop the migration");
    assert.ok(lstatSync(join(live, ".git")).isFile(), "gitfile never moved");
  }
  // worktree not locked (rollback would expire with the next prune)
  {
    const repo = fixtureRepo();
    const live = linkedLive(repo);
    git(repo, "worktree", "unlock", live);
    const r = runBlock(MIGRATE, live, repo);
    assert.notEqual(r.status, 0, "unlocked worktree must stop the migration");
    assert.ok(lstatSync(join(live, ".git")).isFile(), "gitfile never moved");
    assert.ok(!existsSync(join(live, ".git-pawprint-retired")));
  }
  // a worktree of a DIFFERENT repo (common-dir mismatch)
  {
    const repoA = fixtureRepo();
    const repoB = fixtureRepo();
    git(repoB, "switch", "-q", "--detach");
    const live = join(mktmp("mig"), "pi");
    git(repoB, "worktree", "add", "-q", "--lock", live, "main");
    const r = runBlock(MIGRATE, live, repoA);
    assert.notEqual(r.status, 0, "common-dir mismatch must stop the migration");
    assert.ok(lstatSync(join(live, ".git")).isFile(), "gitfile never moved");
  }
});

test("rollback preconditions stop before the rename", () => {
  // retired pointer is a DIRECTORY, not the renamed gitfile
  {
    const repo = fixtureRepo();
    const live = linkedLive(repo);
    const gitfile = readFileSync(join(live, ".git"));
    spawnSync("rm", [join(live, ".git")]);
    mkdirSync(join(live, ".git-pawprint-retired"));
    writeFileSync(join(live, ".git-pawprint-retired", "stray"), gitfile);
    const r = runBlock(ROLLBACK, live, repo);
    assert.notEqual(r.status, 0, "retired-as-directory must stop rollback");
    assert.ok(!existsSync(join(live, ".git")), "no nested .git/.git created");
  }
  // an active .git pointer already exists
  {
    const repo = fixtureRepo();
    const live = linkedLive(repo);
    writeFileSync(join(live, ".git-pawprint-retired"), "gitdir: /elsewhere\n");
    const r = runBlock(ROLLBACK, live, repo);
    assert.notEqual(r.status, 0, "existing active pointer must stop rollback");
    assert.match(readFileSync(join(live, ".git"), "utf8"), /^gitdir: /, "active gitfile untouched");
  }
});

function advanceOrigin(repo: string): string {
  const other = join(mktmp("mig"), "other");
  execFileSync("git", ["clone", "-q", join(dirname(repo), "origin.git"), other]);
  writeFileSync(join(other, "agent", "AGENTS.md"), "v2\n");
  git(other, "add", "agent/AGENTS.md");
  git(other, "commit", "-qm", "v2");
  git(other, "push", "-q", "origin", "HEAD:main");
  return git(other, "rev-parse", "HEAD");
}

test("source refresh fast-forwards main and remains attached", () => {
  const repo = fixtureRepo();
  const originHead = advanceOrigin(repo);
  const r = runBlock(REFRESH, repo, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(repo, "rev-parse", "main"), originHead, "main fast-forwarded");
  assert.equal(git(repo, "branch", "--show-current"), "main", "still attached to main");
  assert.equal(readFileSync(join(repo, "agent", "AGENTS.md"), "utf8"), "v2\n");
});

for (const checkout of ["detached", "task"]) {
  test(`source refresh refuses ${checkout} before fetch, merge or apply`, () => {
    const repo = fixtureRepo();
    if (checkout === "detached") git(repo, "switch", "-q", "--detach");
    else git(repo, "switch", "-qc", checkout);
    advanceOrigin(repo);
    const before = {
      head: git(repo, "rev-parse", "HEAD"),
      main: git(repo, "rev-parse", "main"),
      remote: git(repo, "rev-parse", "origin/main"),
      fetch: readFileSync(join(repo, ".git", "FETCH_HEAD"), "utf8"),
      branch: git(repo, "branch", "--show-current"),
      status: git(repo, "status", "--porcelain"),
      content: readFileSync(join(repo, "agent", "AGENTS.md"), "utf8"),
    };
    const r = runBlock(`${REFRESH}touch "$CLONE/applied"\n`, repo, repo);
    assert.notEqual(r.status, 0, "non-main checkout must stop the deploy sequence");
    assert.equal(git(repo, "rev-parse", "HEAD"), before.head);
    assert.equal(git(repo, "rev-parse", "main"), before.main);
    assert.equal(git(repo, "rev-parse", "origin/main"), before.remote, "no fetch");
    assert.equal(readFileSync(join(repo, ".git", "FETCH_HEAD"), "utf8"), before.fetch);
    assert.equal(git(repo, "branch", "--show-current"), before.branch, "no branch switch");
    assert.equal(git(repo, "status", "--porcelain"), before.status);
    assert.equal(readFileSync(join(repo, "agent", "AGENTS.md"), "utf8"), before.content);
    assert.ok(!existsSync(join(repo, "applied")), "apply step not reached");
  });
}

test("source refresh refuses a non-fast-forward without merging or applying", () => {
  const repo = fixtureRepo();
  advanceOrigin(repo);
  writeFileSync(join(repo, "README.md"), "local\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "local");
  const head = git(repo, "rev-parse", "HEAD");
  const r = runBlock(`${REFRESH}touch "$CLONE/applied"\n`, repo, repo);
  assert.notEqual(r.status, 0);
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "rev-parse", "HEAD"), head, "no merge commit or reset");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "local\n");
  assert.ok(!existsSync(join(repo, "applied")), "apply step not reached");
});

test("migration completion frees main without touching live files or unrelated worktrees; rollback then cannot relink", () => {
  const repo = fixtureRepo();
  const live = linkedLive(repo);
  const unrelated = join(mktmp("mig"), "task");
  git(repo, "worktree", "add", "-qb", "task", unrelated);
  const settings = readFileSync(join(live, "agent", "settings.json"));
  const session = readFileSync(join(live, "agent", "sessions", "s.jsonl"));
  const sentinel = readFileSync(join(live, "agent", "auth.json"));
  const admin = readFileSync(join(live, ".git"), "utf8").trim().replace(/^gitdir: /, "");
  const mig = runBlock(MIGRATE, live, repo);
  assert.equal(mig.status, 0, mig.stderr);
  git(repo, "worktree", "unlock", live);
  const dryRun = spawnSync("git", ["-C", repo, "worktree", "prune", "--dry-run", "--verbose", "--expire", "now"], { encoding: "utf8" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const candidates = `${dryRun.stdout}${dryRun.stderr}`.trim();
  assert.equal(candidates.split("\n").length, 1, "only the retired entry may be pruned");
  assert.ok(candidates.startsWith(`Removing worktrees/${admin.split("/").at(-1)}:`), candidates);
  git(repo, "worktree", "prune", "--verbose", "--expire", "now");
  git(repo, "switch", "main");
  assert.equal(git(repo, "branch", "--show-current"), "main", "base returned to main");
  assert.ok(!git(repo, "worktree", "list").includes(live), "admin entry gone");
  assert.equal(git(unrelated, "branch", "--show-current"), "task", "unrelated worktree kept");
  assert.match(git(repo, "worktree", "list", "--porcelain"), new RegExp(`worktree ${unrelated}\\n`));
  assert.deepEqual(readFileSync(join(live, "agent", "settings.json")), settings);
  assert.deepEqual(readFileSync(join(live, "agent", "sessions", "s.jsonl")), session);
  assert.deepEqual(readFileSync(join(live, "agent", "auth.json")), sentinel);
  assert.ok(!existsSync(join(live, ".git")), "live remains plain");

  spawnSync("mv", [join(live, ".git-pawprint-retired"), join(live, ".git")]);
  const gone = runBlock("git -C \"$LIVE\" status", live, repo);
  assert.notEqual(gone.status, 0, "rename-back alone no longer relinks");
  const repair = spawnSync("git", ["-C", repo, "worktree", "repair", live], { encoding: "utf8" });
  assert.notEqual(repair.status, 0);
  assert.notEqual(runBlock("git -C \"$LIVE\" branch --show-current", live, repo).status, 0, "repair cannot recreate a pruned entry — hence: prune only once rollback is unwanted");
});
