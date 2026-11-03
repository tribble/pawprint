import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureFiles, fixtureRepo, git, mktmp } from "./fixture.ts";

test("fixture copy follows unstaged deletion/mv and includes legitimate untracked source", () => {
  const source = join(mktmp("copy-source"), "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  for (const file of ["gone.txt", "before.txt", "dirty.sh"]) writeFileSync(join(source, file), "original\n");
  writeFileSync(join(source, ".gitignore"), "ignored.txt\n");
  git(source, "add", ".");
  git(source, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture", "--no-verify");
  writeFileSync(join(source, "dirty.sh"), "#!/bin/sh\necho dirty\n");
  chmodSync(join(source, "dirty.sh"), 0o755);
  unlinkSync(join(source, "gone.txt"));
  renameSync(join(source, "before.txt"), join(source, "after.txt"));
  writeFileSync(join(source, "new.txt"), "new source\n");
  writeFileSync(join(source, "ignored.txt"), "scratch\n");
  const before = git(source, "status", "--porcelain");
  const plain = fixtureFiles(source);
  assert.equal(existsSync(join(plain, ".git")), false);
  const repo = fixtureRepo(source);
  assert.equal(git(repo, "remote", "get-url", "origin"), join(dirname(repo), "origin.git"));
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
  for (const copied of [plain, repo]) {
    assert.equal(existsSync(join(copied, "gone.txt")), false);
    assert.equal(existsSync(join(copied, "before.txt")), false);
    assert.equal(existsSync(join(copied, "ignored.txt")), false);
    assert.equal(readFileSync(join(copied, "after.txt"), "utf8"), "original\n");
    assert.equal(readFileSync(join(copied, "new.txt"), "utf8"), "new source\n");
    assert.equal(readFileSync(join(copied, "dirty.sh"), "utf8"), "#!/bin/sh\necho dirty\n");
    assert.equal(statSync(join(copied, "dirty.sh")).mode & 0o777, 0o755);
  }
  writeFileSync(join(plain, "new.txt"), "copy-only mutation\n");
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "new source\n");
  assert.equal(readFileSync(join(source, "new.txt"), "utf8"), "new source\n");
  assert.equal(git(source, "status", "--porcelain"), before);
});
