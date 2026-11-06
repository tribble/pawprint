import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { mktmp } from "./fixture.ts";

test("PR helpers preserve CLI contracts through the real standalone client", () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "pr-helpers.fixture.mjs"), mktmp("ph")], {
    encoding: "utf8", timeout: 60000, env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const evidence = JSON.parse(result.stdout.trim()) as { driverPid: number; brokerPid: number; brokerExit: { code: number }; received: number[]; commands: { pid: number; code: number; signal: string | null }[] };
  console.log("PR helper closure " + JSON.stringify({ driverPid: evidence.driverPid, brokerPid: evidence.brokerPid, brokerExit: evidence.brokerExit, commands: evidence.commands.map(({ pid, code, signal }) => ({ pid, code, signal })) }));
  assert.equal(evidence.brokerExit.code, 0);
  assert.deepEqual(evidence.received, [2, 0, 0]);
  assert.ok(evidence.commands.every(command => command.signal === null));
  assert.throws(() => process.kill(evidence.brokerPid, 0), /ESRCH/);
});
