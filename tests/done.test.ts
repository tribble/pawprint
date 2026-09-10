// done.ts: /done archives the transcript out of sessions/ on quit; plain quit
// and non-quit shutdowns (reload/new/resume/fork) leave it alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makePi, makeCtx } from "./harness.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "pi-done-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: done } = await import("../pi-agent/extensions/done.ts");

function setup(name: string) {
  const dir = join(agentDir, "sessions", "--proj--");
  mkdirSync(dir, { recursive: true });
  const sessionFile = join(dir, `${name}.jsonl`);
  writeFileSync(sessionFile, "{}\n");
  const pi = makePi();
  let shutdowns = 0;
  const ctx = makeCtx({ sessionFile, spread: { shutdown: () => (shutdowns += 1) } });
  done(pi);
  const archived = join(agentDir, "sessions-archive", "--proj--", `${name}.jsonl`);
  return { pi, ctx, sessionFile, archived, shutdowns: () => shutdowns };
}

test("/done then quit → file moved to sessions-archive, shutdown requested", async () => {
  const { pi, ctx, sessionFile, archived, shutdowns } = setup("a");
  await pi.commands.done.handler("", ctx);
  assert.equal(shutdowns(), 1);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  assert.ok(!existsSync(sessionFile), "removed from sessions/");
  assert.ok(existsSync(archived), "present in sessions-archive/");
});

test("plain quit without /done → untouched", async () => {
  const { pi, ctx, sessionFile } = setup("b");
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  assert.ok(existsSync(sessionFile));
});

test("/done then non-quit shutdown (reload) → untouched", async () => {
  const { pi, ctx, sessionFile } = setup("c");
  await pi.commands.done.handler("", ctx);
  await pi.emit("session_shutdown", { reason: "reload" }, ctx);
  assert.ok(existsSync(sessionFile));
});
