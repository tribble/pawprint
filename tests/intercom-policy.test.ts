import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { mktmp } from "./fixture.ts";

test("model Intercom auto-pane requests are blocked through real direct and codemode dispatch; human commands stay separate", () => {
  const home = mktmp("intercom-policy");
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "intercom-policy.fixture.mjs")], {
    encoding: "utf8", timeout: 20000,
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TMPDIR: home },
  });
  assert.equal(result.status, 0, `PID ${result.pid}: ${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout) as { pid: number; version: string; blocked: number; ordinaryExecutions: number; humanCommands: number };
  assert.equal(receipt.pid, result.pid);
  assert.equal(receipt.version, "1.5.0");
  assert.equal(receipt.blocked, 12);
  assert.equal(receipt.ordinaryExecutions, 6);
  assert.equal(receipt.humanCommands, 1);
  assert.equal(spawnSync("/bin/ps", ["-p", String(result.pid)], { encoding: "utf8" }).status, 1);
});
