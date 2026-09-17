// validate.sh: the read-only machine-vs-print audit. Fresh imprint → green;
// one drifted file → names exactly that file; missing env var → fails naming it;
// a secret committed anywhere in history → fails (gitleaks); a manifest file
// without a catalog entry, or an entry for an unshipped file → fails naming it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const ENV_OK = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: "SENTINEL-ACCOUNT-9f8",
  CLOUDFLARE_GATEWAY_ID: "SENTINEL-GATEWAY-2b7",
};

// setup.sh wires core.hooksPath into the checkout it runs from; GIT_DIR sends
// that write to a scratch repo so tests never touch this checkout's .git/config.
const GIT_DIR = mkdtempSync(join(tmpdir(), "pawprint-gitdir-"));
execFileSync("git", ["init", "-q", "--bare", GIT_DIR]);
function imprint(t: string) {
  execFileSync("bash", [join(REPO, "setup.sh"), "--all", "--target", t], { encoding: "utf8", env: { ...process.env, GIT_DIR } });
}
function validate(t: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [join(REPO, "scripts", "validate.sh"), "--target", t], {
    encoding: "utf8",
    env,
  });
}

test("fresh imprint → validate green, exit 0", () => {
  const t = mkdtempSync(join(tmpdir(), "pawprint-v1-"));
  imprint(t);
  const r = validate(t, ENV_OK);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes("VALID: machine matches the print"));
  assert.ok(!r.stdout.includes("drift:") && !r.stdout.includes("missing:"));
  assert.ok(r.stdout.includes("tool ok:"), "tools audited");
  assert.ok(r.stdout.includes("about ok:"), "catalog audited");
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

test("one drifted file → validate fails naming exactly that file", () => {
  const t = mkdtempSync(join(tmpdir(), "pawprint-v2-"));
  imprint(t);
  writeFileSync(join(t, "settings.json"), readFileSync(join(t, "settings.json")) + "\n");
  const r = validate(t, ENV_OK);
  assert.equal(r.status, 1);
  const drift = r.stdout.split("\n").filter((l) => l.startsWith("drift:"));
  assert.deepEqual(drift, ["drift:         settings.json"]);
  assert.ok(!r.stdout.includes("missing:"));
});

test("missing managed file → reported as missing, exit 1", () => {
  const t = mkdtempSync(join(tmpdir(), "pawprint-v3-"));
  imprint(t);
  execFileSync("rm", [join(t, "mise.toml")]);
  const r = validate(t, ENV_OK);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("missing:       mise.toml"));
});

test("missing env var → validate fails naming it (presence, never values)", () => {
  const t = mkdtempSync(join(tmpdir(), "pawprint-v4-"));
  imprint(t);
  const env: Record<string, string | undefined> = { ...ENV_OK };
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const r = validate(t, env);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("env MISSING:   CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(!r.stdout.includes("SENTINEL-GATEWAY-2b7"), "values never printed");
});

test("fake ghp_ token committed in a clone → validate fails on the secrets line", () => {
  const t = mkdtempSync(join(tmpdir(), "pawprint-v5-"));
  imprint(t);
  const clone = join(mkdtempSync(join(tmpdir(), "pawprint-v5repo-")), "repo");
  execFileSync("git", ["clone", "-q", REPO, clone]);
  copyFileSync(join(REPO, "scripts", "validate.sh"), join(clone, "scripts", "validate.sh"));
  const validateClone = (env = ENV_OK) =>
    spawnSync("bash", [join(clone, "scripts", "validate.sh"), "--target", t], { encoding: "utf8", env });
  assert.ok(validateClone().stdout.includes("secrets ok:"), "clean history passes the scan");
  // split so this source file never contains a token-shaped literal itself
  const fake = "ghp_" + "Qm7xT2vLp9RkZs4WnJ3hYb8CdF6gAe1UiO5tX0".slice(0, 36);
  writeFileSync(join(clone, "pi-agent", "leak.txt"), `token = "${fake}"\n`);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  git("add", "-f", "pi-agent/leak.txt");
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
