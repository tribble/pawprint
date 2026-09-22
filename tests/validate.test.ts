// validate.sh: the read-only audit of the live worktree. Fresh setup → green
// naming main == origin/main; a modified, deleted or new file under agent/ →
// DRIFT naming exactly it; an unpushed commit / unlock → named; a target that
// is no worktree of this repo → fails; missing env var → fails naming it; a
// secret committed anywhere in history → fails (gitleaks); a manifest file
// without a catalog entry, or an entry for an unshipped file → fails naming it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, fixtureRepo, git, setupAll } from "./fixture.ts";

const ENV_OK = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: "SENTINEL-ACCOUNT-9f8",
  CLOUDFLARE_GATEWAY_ID: "SENTINEL-GATEWAY-2b7",
};

/** fixture repo + its live worktree at <tmp>/pi; validate runs from the fixture. */
function liveFixture() {
  const repo = fixtureRepo();
  const live = join(mkdtempSync(join(tmpdir(), "pawprint-v-")), "pi");
  const r = setupAll(repo, live);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { repo, live };
}
function validate(repo: string, live: string, env: NodeJS.ProcessEnv = ENV_OK) {
  return spawnSync("bash", [join(repo, "scripts", "validate.sh"), "--target", join(live, "agent")], { encoding: "utf8", env });
}
const liveLines = (out: string) => out.split("\n").filter((l) => /^(live|DRIFT)/.test(l));

test("fresh setup → validate green, exit 0, live line names main == origin/main", () => {
  const { repo, live } = liveFixture();
  const r = validate(repo, live);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes("VALID: live config is the checkout"));
  assert.deepEqual(liveLines(r.stdout), [`live:          clean (main ${git(live, "rev-parse", "--short", "HEAD")} == origin/main)`]);
  assert.ok(r.stdout.includes("manifest ok:"), "manifest == tracked agent/ files");
  assert.ok(r.stdout.includes("tool ok:"), "tools audited");
  assert.ok(r.stdout.includes("about ok:"), "catalog audited");
});

test("modified, deleted and new file under agent/ → DRIFT names exactly those; runtime files never", () => {
  const { repo, live } = liveFixture();
  writeFileSync(join(live, "agent", "settings.json"), readFileSync(join(live, "agent", "settings.json")) + "\n");
  rmSync(join(live, "agent", "cloak.json"));
  writeFileSync(join(live, "agent", "agents", "new.md"), "new\n");
  writeFileSync(join(live, "agent", "auth.json"), "SENTINEL");
  mkdirSync(join(live, "agent", "sessions")); writeFileSync(join(live, "agent", "sessions", "s.jsonl"), "{}");
  const r = validate(repo, live);
  assert.equal(r.status, 1);
  assert.deepEqual(liveLines(r.stdout).sort(), ["DRIFT:         agent/agents/new.md", "DRIFT:         agent/cloak.json", "DRIFT:         agent/settings.json"]);
});

test("pi's lastChangelogVersion stamp alone → `live:` names the keep command with the new version, exit 0; any other change → DRIFT", () => {
  const { repo, live } = liveFixture();
  const settings = join(live, "agent", "settings.json");
  const stamp = (v: string) => writeFileSync(settings, readFileSync(settings, "utf8").replace(/"lastChangelogVersion": "[^"]*"/, `"lastChangelogVersion": "${v}"`));
  stamp("0.88.0");
  let r = validate(repo, live);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(liveLines(r.stdout), [
    "live:          pi wrote agent/settings.json (lastChangelogVersion) — keep: git -C " + live + " add -p agent/settings.json && git -C " + live + " commit -m 'pi 0.88.0 stamp' && git -C " + live + " push",
  ]);
  assert.ok(r.stdout.includes("VALID: live config is the checkout"));
  // the stamp plus any other settings change is ordinary drift
  writeFileSync(settings, readFileSync(settings, "utf8").replace('"quietStartup": true', '"quietStartup": false'));
  r = validate(repo, live);
  assert.equal(r.status, 1);
  assert.deepEqual(liveLines(r.stdout), ["DRIFT:         agent/settings.json"]);
  // the stamp plus another modified file: both DRIFT
  stamp("0.88.0"); writeFileSync(settings, readFileSync(settings, "utf8").replace('"quietStartup": false', '"quietStartup": true'));
  writeFileSync(join(live, "agent", "cloak.json"), "\n", { flag: "a" });
  r = validate(repo, live);
  assert.equal(r.status, 1);
  assert.deepEqual(liveLines(r.stdout).sort(), ["DRIFT:         agent/cloak.json", "DRIFT:         agent/settings.json"]);
  git(live, "checkout", "--", "agent/cloak.json");
  // a property smuggled onto the stamp line is not a stamp
  writeFileSync(settings, readFileSync(settings, "utf8").replace(/"lastChangelogVersion": "0.88.0",/, '"lastChangelogVersion": "0.88.0", "enableSkillCommands": false,'));
  r = validate(repo, live);
  assert.equal(r.status, 1);
  assert.deepEqual(liveLines(r.stdout), ["DRIFT:         agent/settings.json"]);
  // the stamp plus a mode change is not a stamp — whatever git's color or fileMode config says
  for (const cfg of [[], ["color.ui=always"], ["core.fileMode=false"]]) {
    git(live, "checkout", "--", "agent/settings.json"); stamp("0.88.0"); chmodSync(settings, 0o755);
    const env = { ...ENV_OK, GIT_CONFIG_COUNT: String(cfg.length), ...Object.fromEntries(cfg.flatMap((kv, i) => { const [k, v] = kv.split("="); return [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]]; })) };
    r = validate(repo, live, env);
    assert.equal(r.status, 1, cfg.join());
    assert.deepEqual(liveLines(r.stdout), ["DRIFT:         agent/settings.json"], cfg.join());
    chmodSync(settings, 0o644);
  }
  // two stamp lines already committed: ambiguous, never a stamp
  git(live, "checkout", "--", "agent/settings.json");
  writeFileSync(settings, readFileSync(settings, "utf8").replace(/(\n  "lastChangelogVersion": "[^"]*",)/, "$1$1"));
  git(live, "commit", "-q", "--no-verify", "-am", "dup"); git(live, "push", "-q");
  writeFileSync(settings, readFileSync(settings, "utf8").replace(/"lastChangelogVersion": "[^"]*"/, '"lastChangelogVersion": "0.89.0"'));
  r = validate(repo, live);
  assert.equal(r.status, 1);
  assert.deepEqual(liveLines(r.stdout), ["DRIFT:         agent/settings.json"]);
});

test("unpushed commit, unlocked worktree, wrong branch → each named, exit 1", () => {
  const { repo, live } = liveFixture();
  writeFileSync(join(live, "agent", "settings.json"), readFileSync(join(live, "agent", "settings.json")) + "\n");
  git(live, "commit", "-q", "--no-verify", "-am", "local change");
  git(live, "worktree", "unlock", live);
  let r = validate(repo, live);
  assert.equal(r.status, 1);
  assert.deepEqual(liveLines(r.stdout).map((l) => l.split(":")[0]), ["live UNLOCKED", "live UNPUSHED"]);
  assert.match(r.stdout, /live UNPUSHED: 1 commit\(s\)/);
  git(live, "switch", "-q", "-c", "side");
  r = validate(repo, live);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^live BRANCH:\s+side \(want main\)$/m);
});

test("target that is no worktree of this repo → fails naming the fix", () => {
  const { repo } = liveFixture();
  const r = validate(repo, mkdtempSync(join(tmpdir(), "pawprint-vn-")));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^live NOT WORKTREE: .* setup\.sh --all$/m);
});

test("manifest files[] out of step with tracked agent/ files → fails naming both sides", () => {
  const { repo, live } = liveFixture();
  execFileSync("sh", ["-c", "jq '.files |= map(select(. != \"cloak.json\")) + [\"ghost.md\"] | .about[\"ghost.md\"] = {does: \"x\"}' manifest.json > m.json && mv m.json manifest.json"], { cwd: repo });
  const r = validate(repo, live);
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.split("\n").filter((l) => /^[<>] /.test(l)), ["> cloak.json", "< ghost.md"]);
});

test("catalog: missing/empty `about` and an `about` for an unshipped file → fails naming each", () => {
  // validate.sh resolves manifest.json relative to itself, so a two-file stand-in repo is enough
  const fake = mkdtempSync(join(tmpdir(), "pawprint-v6-"));
  mkdirSync(join(fake, "scripts"));
  copyFileSync(join(REPO, "scripts", "validate.sh"), join(fake, "scripts", "validate.sh"));
  writeFileSync(join(fake, "manifest.json"), JSON.stringify({
    files: ["a.md", "b.md", "c.md"],
    about: { "a.md": { does: "fine" }, "b.md": { does: "" }, "z.md": { does: "orphan" } },
    tools: [], env: [],
  }));
  const r = spawnSync("bash", [join(fake, "scripts", "validate.sh"), "--target", fake], { encoding: "utf8", env: ENV_OK });
  assert.equal(r.status, 1);
  assert.deepEqual(
    r.stdout.split("\n").filter((l) => l.startsWith("about ")),
    ["about MISSING: b.md", "about MISSING: c.md", "about ORPHAN:  z.md (not in files[])"],
  );
});

test("catalog: a `does` over 80 chars → fails naming the path and length", () => {
  const fake = mkdtempSync(join(tmpdir(), "pawprint-v7-"));
  mkdirSync(join(fake, "scripts"));
  copyFileSync(join(REPO, "scripts", "validate.sh"), join(fake, "scripts", "validate.sh"));
  writeFileSync(join(fake, "manifest.json"), JSON.stringify({
    files: ["a.md"],
    about: { "a.md": { does: "x".repeat(81) } },
    tools: [], env: [],
  }));
  const r = spawnSync("bash", [join(fake, "scripts", "validate.sh"), "--target", fake], { encoding: "utf8", env: ENV_OK });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("about LONG:    a.md (81 chars)"), r.stdout);
});

test("missing env var → validate fails naming it (presence, never values)", () => {
  const { repo, live } = liveFixture();
  const env: Record<string, string | undefined> = { ...ENV_OK };
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const r = validate(repo, live, env);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("env MISSING:   CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(!r.stdout.includes("SENTINEL-GATEWAY-2b7"), "values never printed");
});

test("fake ghp_ token committed in a clone → validate fails on the secrets line", () => {
  const t = mkdtempSync(join(tmpdir(), "pawprint-v5-"));
  const clone = join(mkdtempSync(join(tmpdir(), "pawprint-v5repo-")), "repo");
  execFileSync("git", ["clone", "-q", REPO, clone]);
  copyFileSync(join(REPO, "scripts", "validate.sh"), join(clone, "scripts", "validate.sh"));
  const validateClone = (env = ENV_OK) =>
    spawnSync("bash", [join(clone, "scripts", "validate.sh"), "--target", t], { encoding: "utf8", env });
  assert.ok(validateClone().stdout.includes("secrets ok:"), "clean history passes the scan");
  // split so this source file never contains a token-shaped literal itself
  const fake = "ghp_" + "Qm7xT2vLp9RkZs4WnJ3hYb8CdF6gAe1UiO5tX0".slice(0, 36);
  writeFileSync(join(clone, "agent", "leak.txt"), `token = "${fake}"\n`);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  git("add", "-f", "agent/leak.txt");
  git("commit", "-q", "--no-verify", "-m", "leak");
  const r = validateClone();
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("secrets FAIL:"), r.stdout);
  assert.ok(!r.stdout.includes(fake), "secret never printed");
  // gitleaks parses git's patch output: a colored patch silently scans as clean,
  // and a git failure leaves gitleaks exiting 0 with "0 commits scanned"
  const gitEnv = (key: string, value: string) =>
    ({ ...ENV_OK, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: value });
  assert.ok(validateClone(gitEnv("color.ui", "always")).stdout.includes("secrets FAIL:"), "colored patch still fails");
  const broken = validateClone(gitEnv("diff.algorithm", "nope"));
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /secrets FAIL:.*diff\.algorithm/, "git error is reported, not passed as clean");
});
