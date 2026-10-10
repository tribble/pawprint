import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepo, git, mktmp } from "./fixture.ts";

test("fixture copy follows unstaged deletion/mv and includes legitimate untracked source", () => {
  const source = join(mktmp("copy-source"), "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  for (const file of ["gone.txt", "before.txt"]) writeFileSync(join(source, file), "original\n");
  writeFileSync(join(source, ".gitignore"), "ignored.txt\n");
  git(source, "add", ".");
  git(source, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture", "--no-verify");
  unlinkSync(join(source, "gone.txt"));
  renameSync(join(source, "before.txt"), join(source, "after.txt"));
  writeFileSync(join(source, "new.txt"), "new source\n");
  writeFileSync(join(source, "ignored.txt"), "scratch\n");
  const before = git(source, "status", "--porcelain");
  const copied = fixtureRepo(source);
  assert.equal(existsSync(join(copied, "gone.txt")), false);
  assert.equal(existsSync(join(copied, "before.txt")), false);
  assert.equal(existsSync(join(copied, "ignored.txt")), false);
  assert.equal(readFileSync(join(copied, "after.txt"), "utf8"), "original\n");
  assert.equal(readFileSync(join(copied, "new.txt"), "utf8"), "new source\n");
  assert.equal(git(source, "status", "--porcelain"), before);
});
