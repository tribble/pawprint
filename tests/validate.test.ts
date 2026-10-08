// validate.sh: the read-only audit of a plain live dir. Fresh setup → green
// naming the applied match; a changed managed value, a missing or differing
// source-only file → named; runtime-owned and unmanaged live additions are
// never drift; a git-linked target fails naming the migration. Manifest
// catalog, tools, env (presence only) and secrets-history checks unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { linkSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { REPO, fixtureRepo, mktmp, setupAll } from "./fixture.ts";

const ENV_OK = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: "SENTINEL-ACCOUNT-9f8",
  CLOUDFLARE_GATEWAY_ID: "SENTINEL-GATEWAY-2b7",
};

/** fixture repo + its plain live dir at <scratch>/pi; validate runs from the fixture. */
function liveFixture() {
  const repo = fixtureRepo();
  const live = join(mktmp("v"), "pi");
  const r = setupAll(repo, live);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { repo, live };
}
function validate(repo: string, live: string, env: NodeJS.ProcessEnv = ENV_OK, target = join(live, "agent")) {
  return spawnSync("bash", [join(repo, "scripts", "validate.sh"), "--target", target], { encoding: "utf8", env });
}
const liveLines = (out: string) => out.split("\n").filter((l) => /^(live|DRIFT|MISSING)/.test(l));

test("fresh setup → validate green, exit 0, live line reports the applied match", () => {
  const { repo, live } = liveFixture();
  const r = validate(repo, live);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes("VALID: live config matches the print"));
  assert.deepEqual(liveLines(r.stdout), [`live:          applied (${join(live, "agent")} matches the print)`]);
  assert.ok(r.stdout.includes("manifest ok:"), "manifest == tracked agent/ files");
  assert.ok(r.stdout.includes("tool ok:"), "tools audited");
  assert.ok(r.stdout.includes("about ok:"), "catalog audited");
});

test("changed managed values and missing/differing source files are named; runtime and unmanaged additions are not drift", () => {
  const { repo, live } = liveFixture();
  const agent = join(live, "agent");
  // managed drift: a managed value changed, a managed MCP url changed, a
  // source-only file differs, one is missing
  const settingsPath = join(agent, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.quietStartup = false;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  const mcpPath = join(agent, "mcp.json");
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  mcp.mcpServers["slack-workos"].url = "https://wrong.example/mcp";
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));
  writeFileSync(join(agent, "AGENTS.md"), readFileSync(join(agent, "AGENTS.md"), "utf8") + "\nlive edit\n");
  rmSync(join(agent, "cloak.json"));
  // runtime and unmanaged additions: none of this is drift
  writeFileSync(join(agent, "auth.json"), "SENTINEL");
  mkdirSync(join(agent, "sessions"));
  writeFileSync(join(agent, "sessions", "s.jsonl"), "{}");
  writeFileSync(join(agent, "agents", "new.md"), "new\n");
  const stamped = { ...JSON.parse(readFileSync(settingsPath, "utf8")), lastChangelogVersion: "999.0.0", deviceId: "synthetic", editorPaddingX: 9 };
  writeFileSync(settingsPath, JSON.stringify(stamped, null, 2));
  const mcpPlus = JSON.parse(readFileSync(mcpPath, "utf8"));
  mcpPlus.mcpServers["local-only"] = { command: "fake" };
  mcpPlus.mcpServers["slack-workos"].enabled = false;
  mcpPlus.autoEnableCodemode = false;
  writeFileSync(mcpPath, JSON.stringify(mcpPlus, null, 2));

  const r = validate(repo, live);
  assert.equal(r.status, 1);
  assert.deepEqual(liveLines(r.stdout).sort(), [
    "DRIFT:         AGENTS.md (differs from source — setup.sh --apply)",
    "DRIFT:         mcp.json (managed values differ — setup.sh --apply)",
    "DRIFT:         settings.json (managed values differ — setup.sh --apply)",
    "MISSING:       cloak.json (setup.sh --apply)",
  ]);

  // re-apply repairs the drift; every runtime/unmanaged addition stays and is green
  const again = setupAll(repo, live);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  const ok = validate(repo, live);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.ok(readFileSync(settingsPath, "utf8").includes("999.0.0"), "runtime stamp kept through re-apply");
  assert.ok(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers["local-only"], "live-only server kept");
});

test("a git-linked target fails, naming the migration", () => {
  const { repo, live } = liveFixture();
  execFileSync("git", ["init", "-q", live]);
  const r = validate(repo, live);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^live GIT-LINKED: .*retire the worktree metadata/m);
});

test("aliased target spellings cannot bypass git-link detection or the shape guard", () => {
  const { repo, live } = liveFixture();
  execFileSync("git", ["init", "-q", live]);
  // string concatenation, not path.join: join() would normalize the aliases away
  for (const spelling of [`${live}/agent/.`, `${live}/agent/`]) {
    const r = validate(repo, live, ENV_OK, spelling);
    assert.equal(r.status, 1, spelling);
    assert.match(r.stdout, /^live GIT-LINKED:/m, spelling);
  }
  // a '..' spelling never reaches the git-link check: refused at the door
  const dd = validate(repo, live, ENV_OK, `${live}/agent/../agent`);
  assert.equal(dd.status, 2);
  assert.match(dd.stderr, /'\.\.'.*without \.\./);
});

test("an empty or '..' --target is refused before any audit runs", () => {
  for (const [t, pattern] of [["", /empty --target/], ["/nonexistent/x/../agent", /'\.\.'.*without \.\./]] as const) {
    const r = spawnSync("bash", [join(REPO, "scripts", "validate.sh"), "--target", t], { encoding: "utf8", env: ENV_OK });
    assert.equal(r.status, 2, t || "(empty)");
    assert.match(r.stderr, pattern);
    assert.equal(r.stdout, "", "no audit output from a refused run");
  }
});

test("a symlinked config root is not silently followed (validate names it unsafe)", () => {
  const { repo } = liveFixture();
  const home = mktmp("vroot");
  const real = join(home, "real");
  mkdirSync(join(real, "agent"), { recursive: true });
  // a fully applied live dir, reached through a symlinked .pi
  const applied = setupAll(repo, real);
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  symlinkSync(real, join(home, ".pi"));
  const r = validate(repo, join(home, ".pi"), ENV_OK, join(home, ".pi", "agent"));
  assert.equal(r.status, 1, "symlinked root must not validate clean");
  assert.match(r.stdout, /unsafe|refus/, "the guard's reason is named, not a diff");
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
  const fake = mktmp("v6");
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
  const fake = mktmp("v7");
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

test("unsafe live file shapes are rejected: symlinked, hardlinked, or non-regular targets", () => {
  const { repo, live } = liveFixture();
  const agent = join(live, "agent");

  // a symlinked source-only file with MATCHING content — cmp alone would pass it
  const ag = readFileSync(join(agent, "AGENTS.md"));
  rmSync(join(agent, "AGENTS.md"));
  writeFileSync(join(agent, "AGENTS.md.real"), ag);
  symlinkSync(join(agent, "AGENTS.md.real"), join(agent, "AGENTS.md"));

  // a hardlinked source-only file with matching content
  const cloak = readFileSync(join(agent, "cloak.json"));
  rmSync(join(agent, "cloak.json"));
  writeFileSync(join(agent, "cloak.linked"), cloak);
  linkSync(join(agent, "cloak.linked"), join(agent, "cloak.json"));

  // a directory where a managed file belongs
  rmSync(join(agent, "presets.json"));
  mkdirSync(join(agent, "presets.json"));

  // a symlinked settings.json (matching content — merge alone would pass it)
  const st = readFileSync(join(agent, "settings.json"));
  rmSync(join(agent, "settings.json"));
  writeFileSync(join(agent, "settings.real.json"), st);
  symlinkSync(join(agent, "settings.real.json"), join(agent, "settings.json"));

  const r = validate(repo, live);
  assert.equal(r.status, 1, r.stdout);
  const lines = liveLines(r.stdout).join("\n");
  assert.match(lines, /AGENTS\.md \(unsafe/, "symlinked source-only file named");
  assert.match(lines, /cloak\.json \(unsafe/, "hardlinked source-only file named");
  assert.match(lines, /presets\.json \(unsafe/, "directory collision named");
  assert.match(lines, /settings\.json/, "settings refusal surfaced");
  assert.match(lines, /refus|unsafe/, "the reason names the guard, not a diff");
});

test("fake ghp_ token committed in a clone → validate fails on the secrets line", () => {
  const t = mktmp("v5");
  const clone = join(mktmp("v5repo"), "repo");
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
