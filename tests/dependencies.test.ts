import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mktmp, REPO } from "./fixture.ts";

test("Pi's production git install omits development tools and host-provided peers", () => {
  const dir = mktmp("production-deps");
  for (const file of ["package.json", "package-lock.json"]) copyFileSync(join(REPO, file), join(dir, file));
  execFileSync("npm", [
    "install", "--omit=dev", "--legacy-peer-deps", "--offline",
    "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(dir, "cache"),
  ], { cwd: dir, stdio: "pipe" });
  const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
  };
  for (const name of new Set([...Object.keys(manifest.devDependencies), ...Object.keys(manifest.peerDependencies)])) {
    assert.equal(existsSync(join(dir, "node_modules", name)), false, `${name} must not be production-installed`);
  }
});
