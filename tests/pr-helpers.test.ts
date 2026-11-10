import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mktmp } from "./fixture.ts";

// Unix socket paths cap near 104 bytes, so the fixture gets a short private alias to `dir`.
// The test owns it: a spawnSync timeout SIGTERMs the fixture, which skips any cleanup there.
function runFixture(dir: string, timeout: number) {
  const aliasRoot = mkdtempSync("/tmp/pp-"), alias = join(aliasRoot, "a");
  try {
    symlinkSync(dir, alias);
    return { aliasRoot, result: spawnSync(process.execPath, [join(import.meta.dirname, "pr-helpers.fixture.mjs"), dir, alias], { encoding: "utf8", timeout, env: { PATH: process.env.PATH } }) };
  } finally { rmSync(alias, { force: true }); rmdirSync(aliasRoot); }
}

test("PR helpers preserve CLI contracts through the real standalone client", () => {
  // Longer than the Unix socket limit on its own, so the fixture must work from any checkout path.
  const dir = join(mktmp("ph"), "deliberately-long-fixture-path-".repeat(4));
  const { aliasRoot, result } = runFixture(dir, 60000);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const evidence = JSON.parse(result.stdout.trim()) as { driverPid: number; brokerPid: number; brokerExit: { code: number }; socket: string; received: number[]; commands: { pid: number; code: number; signal: string | null }[] };
  console.log("PR helper closure " + JSON.stringify({ driverPid: evidence.driverPid, brokerPid: evidence.brokerPid, brokerExit: evidence.brokerExit, aliasRoot, socket: evidence.socket, commands: evidence.commands.map(({ pid, code, signal }) => ({ pid, code, signal })) }));
  assert.equal(evidence.brokerExit.code, 0);
  assert.deepEqual(evidence.received, [2, 0, 0]);
  assert.ok(evidence.commands.every(command => command.signal === null));
  assert.throws(() => process.kill(evidence.brokerPid, 0), /ESRCH/);
  assert.equal(existsSync(aliasRoot), false);
});

test("PR helper fixture alias is removed when the fixture times out", () => {
  // 1 ms kills the driver long before it can spawn the broker.
  const { aliasRoot, result } = runFixture(join(mktmp("ph"), "fixture"), 1);
  console.log("PR helper timeout closure " + JSON.stringify({ driverPid: result.pid, signal: result.signal, aliasRoot }));
  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGTERM");
  assert.throws(() => process.kill(result.pid, 0), /ESRCH/);
  assert.equal(existsSync(aliasRoot), false);
});
