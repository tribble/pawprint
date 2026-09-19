// .githooks/pre-commit, wired by setup.sh: a staged secret is refused by
// `git commit` itself — also when git is told to color its output (a colored
// patch scans as clean) and when git fails outright (gitleaks then exits 0
// having scanned nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");

test("setup.sh wires the hook; staged ghp_ token: commit refused, redacted; color and git errors fail closed", () => {
  const clone = join(mkdtempSync(join(tmpdir(), "pawprint-hook-")), "repo");
  execFileSync("git", ["clone", "-q", REPO, clone]);
  for (const f of [".githooks/pre-commit", "setup.sh"]) copyFileSync(join(REPO, f), join(clone, f));
  const git = (...a: string[]) =>
    spawnSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  execFileSync("bash", [join(clone, "setup.sh"), "--only", "AGENTS.md", "--target", mkdtempSync(join(tmpdir(), "pawprint-hook-t-"))]);
  assert.equal(git("config", "core.hooksPath").stdout.trim(), ".githooks", "setup.sh wired the hook in the clone");
  // split so this source file never contains a token-shaped literal itself
  const fake = "ghp_" + "Qm7xT2vLp9RkZs4WnJ3hYb8CdF6gAe1UiO5tX0".slice(0, 36);
  writeFileSync(join(clone, "agent", "leak.txt"), `token = "${fake}"\n`);
  assert.equal(git("add", "-f", "agent/leak.txt").status, 0);

  const refused = git("commit", "-q", "-m", "leak");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pawprint: secret in staged changes/);
  assert.match(refused.stderr, /Fingerprint: agent\/leak\.txt:github-pat:1/);
  assert.ok(!refused.stderr.includes(fake) && !refused.stdout.includes(fake), "secret never printed");

  // `git -c` travels into the hook as GIT_CONFIG_PARAMETERS and outranks config files
  const colored = git("-c", "color.ui=always", "commit", "-q", "-m", "leak");
  assert.notEqual(colored.status, 0);
  assert.match(colored.stderr, /pawprint: secret in staged changes/);

  // a textconv git cannot exec makes `git diff --staged` fatal; gitleaks still exits 0
  writeFileSync(join(clone, ".gitattributes"), "agent/leak.txt diff=rf\n");
  assert.equal(git("config", "diff.rf.textconv", "/nonexistent/textconv").status, 0);
  const broken = git("commit", "-q", "-m", "leak");
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /pawprint: gitleaks could not scan/);

  assert.equal(git("log", "--oneline", "-1", "--", "agent/leak.txt").stdout, "", "nothing was committed");
});
