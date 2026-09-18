// imprint.test.ts — setup.sh, encoded. `--all` makes <live> a locked sparse
// worktree (agent/) of the repo the script runs from, adopting equal files,
// checking out missing ones and refusing to overwrite a differing one; `--only`
// copies manifest paths for adopters. Every --all run uses a throwaway fixture
// repo (tests/fixture.ts): nothing here touches this checkout's git or ~/.pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  cpSync, rmSync, chmodSync, readdirSync, statSync, symlinkSync, lstatSync, readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { fixtureRepo, git, setupAll } from "./fixture.ts";

const REPO = join(import.meta.dirname, "..");
const PRINT = join(REPO, "agent");

const printFiles: string[] = JSON.parse(readFileSync(join(REPO, "manifest.json"), "utf8")).files;

function mktmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// setup.sh wires core.hooksPath into the checkout it runs from; GIT_DIR sends
// that write to a scratch repo so tests never touch this checkout's .git/config.
const GIT_DIR = mktmp("pawprint-gitdir-");
execFileSync("git", ["init", "-q", "--bare", GIT_DIR]);
const SETUP_ENV = { ...process.env, GIT_DIR };
function runSetup(args: string[]) {
  return execFileSync("bash", [join(REPO, "setup.sh"), ...args], { encoding: "utf8", env: SETUP_ENV });
}
function spawnSetup(args: string[]) {  // for asserting on exit status + stderr
  return spawnSync("bash", [join(REPO, "setup.sh"), ...args], { encoding: "utf8", env: SETUP_ENV });
}
function manifest(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isSymbolicLink()) out.set(relative(dir, p), "link:" + readlinkSync(p));
      else out.set(relative(dir, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}
function manifestDiff(a: Map<string, string>, b: Map<string, string>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}

function porcelain(live: string) { return git(live, "status", "--porcelain"); }

test("1. fresh target: locked sparse worktree on main, every manifest file, status clean; fixture gives up main; machinery never invoked", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("pawprint-w1-"), "pi");
  // PATH shim: any machinery invocation of these tools leaves a trace file
  const bin = mktmp("pawprint-w1bin-");
  const trace = join(bin, "TRACE");
  for (const tool of ["pi", "npm", "mise", "gh", "agent-browser"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> "${trace}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  assert.equal(git(repo, "branch", "--show-current"), "main", "fixture starts on main");
  const r = setupAll(repo, live, [], { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of printFiles) assert.ok(existsSync(join(live, "agent", f)), `checked out: ${f}`);
  assert.equal(porcelain(live), "");
  assert.equal(git(live, "branch", "--show-current"), "main");
  assert.equal(git(live, "rev-parse", "--path-format=absolute", "--git-common-dir"), git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), "worktree of the fixture");
  assert.deepEqual(git(live, "sparse-checkout", "list").split("\n").sort(), [".githooks", "agent"]);
  assert.match(git(live, "worktree", "list", "--porcelain"), /^locked/m);
  assert.ok(existsSync(join(live, ".gitignore")) && existsSync(join(live, ".githooks", "pre-commit")), "root files + hook materialized");
  assert.equal(git(repo, "branch", "--show-current"), "", "fixture detached: main is checked out once, in live");
  assert.match(r.stdout, /^detached .* from main/m);
  assert.match(r.stdout, /^live:\s+clean \(.* on main [0-9a-f]+\)$/m);
  for (const step of ["/login", "/mcp-auth", "/trust"]) assert.ok(r.stdout.includes(step), `closing message mentions ${step}`);
  assert.ok(r.stdout.includes("machine machinery: SKIPPED"));
  assert.ok(!existsSync(trace), "no machinery tool was invoked");
  assert.ok(!existsSync(join(live, "agent", "auth.json")));
  // the gitleaks hook guards commits made in live too (hooksPath is repo config; .githooks is in the cone)
  const fake = "ghp_" + "Qm7xT2vLp9RkZs4WnJ3hYb8CdF6gAe1UiO5tX0".slice(0, 36);
  writeFileSync(join(live, "agent", "extensions", "leak.ts"), `token = "${fake}"\n`);
  git(live, "add", "agent/extensions/leak.ts");
  const refused = spawnSync("git", ["-C", live, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "leak"], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pawprint: secret in staged changes/);
});

test("2. existing non-empty target, equal files + runtime decoys: adopted as-is, decoys byte-identical, ignored, unaddable", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("pawprint-w2-"), "pi");
  cpSync(join(repo, "agent"), join(live, "agent"), { recursive: true });
  writeFileSync(join(live, "agent", "auth.json"), JSON.stringify({ junk: "SECRET-DECOY" }));
  mkdirSync(join(live, "agent", "sessions"), { recursive: true });
  writeFileSync(join(live, "agent", "sessions", "x.jsonl"), "{}");
  mkdirSync(join(live, "agent", "git", "x"), { recursive: true });
  writeFileSync(join(live, "agent", "git", "x", "y"), "clone");
  writeFileSync(join(live, "agent", "extensions", "btw.ts.bak-pawprint-20260101000000"), "old");
  writeFileSync(join(live, "agent", "bin", "fd"), "\xcf\xfa\xed\xfe not-a-real-binary");   // unlisted binary under bin/
  const before = manifest(join(live, "agent"));
  const r = setupAll(repo, live);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(manifestDiff(before, manifest(join(live, "agent"))), [], "agent/ untouched — every file was already equal");
  assert.equal(porcelain(live), "", "decoys invisible to git");
  assert.ok(!r.stdout.includes("checked out:   " + join(live, "agent")), "nothing under agent/ was (re)written");
  const add = spawnSync("git", ["-C", live, "add", "agent/auth.json"], { encoding: "utf8" });
  assert.notEqual(add.status, 0, "git add of an ignored runtime file is refused");
  assert.match(add.stderr, /ignored/);
  assert.notEqual(spawnSync("git", ["-C", live, "add", "agent/bin/fd"], { encoding: "utf8" }).status, 0, "bin/ is allowlisted by name: an unlisted binary is ignored");
  assert.equal(JSON.parse(readFileSync(join(live, "agent", "auth.json"), "utf8")).junk, "SECRET-DECOY");
});

test("3. differing live file: DRIFT names it, exit 1, nothing under agent/ overwritten; resolved with git → re-run clean", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("pawprint-w3-"), "pi");
  cpSync(join(repo, "agent"), join(live, "agent"), { recursive: true });
  writeFileSync(join(live, "agent", "settings.json"), readFileSync(join(live, "agent", "settings.json")) + "\nDRIFT-MARKER\n");
  writeFileSync(join(live, "agent", "auth.json"), "SENTINEL");
  const before = manifest(join(live, "agent"));
  const r = setupAll(repo, live);
  assert.equal(r.status, 1);
  assert.deepEqual(r.stderr.split("\n").filter((l) => l.startsWith("DRIFT:")), ["DRIFT:         agent/settings.json"]);
  assert.notEqual(spawnSync("git", ["-C", live, "add", "--dry-run", "agent/auth.json"], { encoding: "utf8" }).status, 0, "refused run still leaves credentials unaddable");
  assert.deepEqual(manifestDiff(before, manifest(join(live, "agent"))), [], "agent/ byte-identical after the refused run");
  assert.ok(readFileSync(join(live, "agent", "settings.json"), "utf8").includes("DRIFT-MARKER"));
  assert.equal(git(live, "diff", "--name-only"), "agent/settings.json", "the drift is a plain git diff in live");
  git(live, "checkout", "--", "agent/settings.json");
  const again = setupAll(repo, live);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(porcelain(live), "");
});

test("3b. a directory or symlink where a tracked file belongs, or a symlinked parent: DRIFT, left exactly as found", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("pawprint-w3b-"), "pi");
  mkdirSync(join(live, "agent", "settings.json"), { recursive: true });
  writeFileSync(join(live, "agent", "settings.json", "must-survive"), "keep");
  mkdirSync(join(live, "agent", "real-prompts"));
  symlinkSync("real-prompts", join(live, "agent", "prompts"));
  symlinkSync("/nonexistent-target", join(live, "agent", "mise.toml"));
  const before = manifest(join(live, "agent"));
  const r = setupAll(repo, live);
  assert.equal(r.status, 1);
  const drift = r.stderr.split("\n").filter((l) => l.startsWith("DRIFT:")).map((l) => l.replace(/ \(in the way: .*\)$/, ""));
  assert.deepEqual(drift.sort(), [
    "DRIFT:         agent/mise.toml",
    "DRIFT:         agent/prompts/extract-process-improvements.md",
    "DRIFT:         agent/prompts/start-ticket.md",
    "DRIFT:         agent/settings.json",
  ]);
  const after = manifest(join(live, "agent"));
  for (const [k, v] of before) assert.equal(after.get(k), v, `pre-existing entry untouched: ${k}`);
  assert.ok(lstatSync(join(live, "agent", "prompts")).isSymbolicLink() && lstatSync(join(live, "agent", "mise.toml")).isSymbolicLink(), "symlinks intact");
  assert.deepEqual(readdirSync(join(live, "agent", "real-prompts")), [], "nothing written through the symlink");
  assert.ok(!r.stderr.includes("DRIFT:         \n"), "no empty DRIFT line");
});

test("3c. an ignore policy of its own in the live tree: refused BEFORE .git is attached", () => {
  const repo = fixtureRepo();
  for (const plant of [
    (live: string) => writeFileSync(join(live, ".gitignore"), "*\n"),
    (live: string) => symlinkSync(join(repo, ".gitignore"), join(live, ".gitignore")),   // equal bytes, but git does not read a symlinked .gitignore
    (live: string) => symlinkSync("/nonexistent", join(live, ".gitignore")),           // dangling: checkout would replace it
    (live: string) => writeFileSync(join(live, "agent", ".gitignore"), "!auth.json\n"),
    (live: string) => { mkdirSync(join(live, "agent", "extensions")); writeFileSync(join(live, "agent", "extensions", ".gitignore"), "!*\n"); },
  ]) {
    const live = join(mktmp("pawprint-w3c-"), "pi");
    mkdirSync(join(live, "agent"), { recursive: true });
    writeFileSync(join(live, "agent", "auth.json"), "SENTINEL");
    plant(live);
    const r = setupAll(repo, live);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^DRIFT:\s+(\.gitignore|agent\/\.gitignore|agent\/extensions\/\.gitignore) .*not attaching$/m);
    assert.ok(!existsSync(join(live, ".git")), "no .git attached");
    assert.equal(git(repo, "branch", "--show-current"), "main", "fixture untouched");
  }
  // main's own .gitignore already in place is fine; so is a .gitignore inside an ignored dir (a package clone): inert
  const live = join(mktmp("pawprint-w3c-"), "pi");
  mkdirSync(join(live, "agent", "git", "github.com", "example", "pkg"), { recursive: true });
  writeFileSync(join(live, "agent", "git", "github.com", "example", "pkg", ".gitignore"), "!*\nnode_modules\n");
  writeFileSync(join(live, "agent", "auth.json"), "SENTINEL");
  writeFileSync(join(live, ".gitignore"), readFileSync(join(repo, ".gitignore")));
  const ok = setupAll(repo, live);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(git(live, "status", "--porcelain"), "", "clone and its .gitignore invisible");
  assert.notEqual(spawnSync("git", ["-C", live, "add", "--dry-run", "agent/auth.json"], { encoding: "utf8" }).status, 0);
});

test("4. second run is a no-op: no worktree creation, no checkouts, still clean; unrelated .git dir at the target is refused", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("pawprint-w4-"), "pi");
  assert.equal(setupAll(repo, live).status, 0);
  const before = manifest(live);
  const r = setupAll(repo, live);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!r.stdout.includes("worktree:") && !r.stdout.includes("checked out:"), r.stdout);
  assert.match(r.stdout, /^live:\s+clean/m);
  assert.deepEqual(manifestDiff(before, manifest(live)), []);

  const other = join(mktmp("pawprint-w4o-"), "pi");
  mkdirSync(other); git(other, "init", "-q");
  const refused = setupAll(repo, other);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /checkout of something else/);
});

test("5. --dry-run on a fresh target writes nothing; --all needs an agent/ target", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("pawprint-w5-"), "pi");
  const dry = setupAll(repo, live, ["--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^DRY: make .* worktree/m);
  assert.ok(!existsSync(live), "nothing created");
  assert.equal(git(repo, "branch", "--show-current"), "main", "fixture still on main");
  const bad = spawnSync("bash", [join(repo, "setup.sh"), "--all", "--config-only", "--target", join(live, "config")], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must be an agent\/ dir/);
});

test("6. main checked out in another worktree: refused naming it, nothing created", () => {
  const repo = fixtureRepo();
  git(repo, "switch", "-q", "--detach");
  const other = join(mktmp("pawprint-w6o-"), "other");
  git(repo, "worktree", "add", "-q", other, "main");
  const live = join(mktmp("pawprint-w6-"), "pi");
  const r = setupAll(repo, live);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /'main' is already used by worktree at '.*other'/);
  assert.deepEqual(readdirSync(live), [], "nothing left behind");
});

test("7. machinery reads the LIVE main checkout: a package deployed to main is installed on re-run, from a detached script checkout", () => {
  const repo = fixtureRepo();
  const home = mktmp("pawprint-w7home-");
  const live = join(home, ".pi");
  const bin = mktmp("pawprint-w7bin-");
  const trace = join(bin, "TRACE");
  for (const tool of ["pi", "npm", "mise", "gh", "agent-browser"]) {   // every machinery tool records its argv
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${trace}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_GATEWAY_ID: "y" };
  const run = () => spawnSync("bash", [join(repo, "setup.sh"), "--all"], { encoding: "utf8", env });
  const installs = () => readFileSync(trace, "utf8").split("\n").filter((l) => l.startsWith("pi install ")).map((l) => l.split(" ")[2]);
  const packages = (dir: string) => JSON.parse(readFileSync(join(dir, "agent", "settings.json"), "utf8")).packages
    .map((p: string | { source: string }) => (typeof p === "string" ? p : p.source));

  let r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(installs(), packages(live), "first run: every package from the live settings.json");
  assert.equal(git(repo, "branch", "--show-current"), "", "script checkout is detached now");

  // deploy: main moves (in live), the script checkout stays where it was
  const settings = JSON.parse(readFileSync(join(live, "agent", "settings.json"), "utf8"));
  settings.packages.push("npm:@example/deployed-later");
  writeFileSync(join(live, "agent", "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  git(live, "commit", "-q", "--no-verify", "-am", "deploy a package");
  assert.ok(!packages(repo).includes("npm:@example/deployed-later"), "script checkout is stale by design");
  rmSync(trace);
  r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(installs().includes("npm:@example/deployed-later"), "re-run installs what main has, not what the stale checkout has");
});

test("11. --list: JSON catalog on stdout only, one entry per manifest file, every `does` filled", () => {
  const files: string[] = JSON.parse(readFileSync(join(REPO, "manifest.json"), "utf8")).files;
  const r = spawnSetup(["--list"]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  const list: { path: string; does: string; needs: string[]; personal: boolean }[] = JSON.parse(r.stdout);
  assert.deepEqual(list.map((e) => e.path), files);
  for (const e of list) {
    assert.ok(e.does.trim(), `does: ${e.path}`);
    assert.ok(Array.isArray(e.needs) && typeof e.personal === "boolean", e.path);
  }
});

test("11b. --list on a TTY: prints a table (path, P, does), not JSON", () => {
  // `script` gives setup.sh a pseudo-TTY so [ -t 1 ] is true; col -b strips the
  // ^D/backspace/CR artifacts `script` emits. macOS-only (script/col syntax).
  const r = spawnSync("bash", ["-c", `script -q /dev/null bash "${join(REPO, "setup.sh")}" --list 2>/dev/null | col -b`], { encoding: "utf8", env: SETUP_ENV });
  if (r.status !== 0 || !r.stdout.trim()) return; // script/col unavailable — skip silently
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  assert.ok(lines[0]!.startsWith("path"), `table header, got: ${lines[0]!.trim()}`);
  assert.ok(r.stdout.includes("does"), "has the does column");
  assert.ok(r.stdout.includes("AGENTS.md"), "has a data row");
  assert.throws(() => JSON.parse(r.stdout), "TTY output is a table, not JSON");
});

test("12. --only: exactly the named files (+ backup of a differing one); unknown path exits 2 untouched; personal warns", () => {
  const t = mktmp("pawprint-t12-");
  const bad = spawnSetup(["--target", t, "--only", "extensions/btw.ts", "nope/x.ts"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /nope\/x\.ts/);
  assert.deepEqual([...manifest(t).keys()], [], "unknown path: nothing copied");
  // an empty arg is not a path: raw, it once selected the target dir itself and cp -a'd it into its own backup
  writeFileSync(join(t, "auth.json"), "SENTINEL");
  const empty = spawnSetup(["--target", t, "--only", "extensions/btw.ts", ""]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /not in manifest\.json files\[\]: ""/);
  assert.deepEqual([...manifest(t).keys()], ["auth.json"], "empty path: nothing copied, nothing backed up");
  rmSync(join(t, "auth.json"));

  mkdirSync(join(t, "extensions"), { recursive: true });
  writeFileSync(join(t, "extensions", "btw.ts"), "// mine\n");
  const dry = runSetup(["--dry-run", "--target", t, "--only", "extensions/btw.ts", "extensions/pr-footer.ts"]);
  assert.equal((dry.match(/^DRY: cp -a /gm) ?? []).length, 3, "plan: one backup + two copies");
  assert.deepEqual([...manifest(t).keys()], ["extensions/btw.ts"], "dry-run wrote nothing");

  const r = spawnSetup(["--target", t, "--only", "extensions/btw.ts", "extensions/pr-footer.ts"]);
  assert.equal(r.status, 0, r.stderr);
  const got = [...manifest(t).keys()].sort();
  const bak = got.find((f) => f.startsWith("extensions/btw.ts.bak-pawprint-"));
  assert.ok(bak, "differing file was backed up");
  assert.deepEqual(got, ["extensions/btw.ts", bak!, "extensions/pr-footer.ts"].sort(), "exactly the two files + the backup");
  assert.equal(readFileSync(join(t, bak!), "utf8"), "// mine\n");
  assert.equal(readFileSync(join(t, "extensions", "btw.ts"), "utf8"), readFileSync(join(PRINT, "extensions", "btw.ts"), "utf8"));
  assert.equal(r.stderr, "", "non-personal files: no warning");
  assert.ok(!r.stdout.includes("Manual steps remain") && r.stdout.includes("machine machinery: SKIPPED"));

  const p = spawnSetup(["--target", t, "--only", "settings.json"]);
  assert.equal(p.status, 0);
  assert.equal(p.stderr.trim(), "settings.json encodes tribble's own choices — read it before you keep it");
  assert.ok(existsSync(join(t, "settings.json")), "personal file still copied");
});

test("13. no selector: bare setup.sh refuses (exit 2, pointer on stderr, target untouched); --all + --only is refused too", () => {
  const t = mktmp("pawprint-t13-");
  writeFileSync(join(t, "auth.json"), "SENTINEL");
  const before = manifest(t);
  for (const args of [["--target", t], ["--dry-run", "--config-only", "--target", t]]) {
    const r = spawnSetup(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    for (const line of ["one person's pi config print", "--list", "--only <path>", "--all"])
      assert.ok(r.stderr.includes(line), `pointer mentions ${line}`);
  }
  const both = spawnSetup(["--target", t, "--all", "--only", "extensions/btw.ts"]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /exclusive/);
  assert.deepEqual(manifestDiff(before, manifest(t)), [], "nothing written by any refused run");
});
