// auto-update.ts: daily TTL gate, single-flight lock, notify-only on
// session_start, /update reloads when extensions changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "./stubs/pi-coding-agent.mjs";
import { makePi, makeCtx, eventually } from "./harness.mjs";

let seq = 0;
async function freshExtension(agentDir: string) {
  setAgentDir(agentDir); // captured at module load (STATE/LOCK paths)
  const mod = await import(`../pi-agent/extensions/auto-update.ts?case=${seq++}`);
  return mod.default;
}

function setup(lastRun?: string) {
  const dir = mkdtempSync(join(tmpdir(), "pawprint-autoupdate-"));
  if (lastRun) writeFileSync(join(dir, ".auto-update.json"), JSON.stringify({ lastRun }));
  return dir;
}

test("registers session_start handler and /update command", async () => {
  const ext = await freshExtension(setup());
  const pi = makePi();
  ext(pi);
  assert.equal(pi.registered("session_start"), 1);
  assert.ok(pi.commands.update);
});

test("fresh state: runs both updates, writes state, releases lock", async () => {
  const dir = setup();
  const ext = await freshExtension(dir);
  const pi = makePi();
  ext(pi);
  await pi.emit("session_start", {}, makeCtx());
  const ok = await eventually(() => existsSync(join(dir, ".auto-update.json")));
  assert.ok(ok, "state file written");
  assert.deepEqual(
    pi.execCalls,
    [
      ["pi", "update", "--self"],
      ["pi", "update", "--extensions", "--no-approve"],
    ],
    "both update commands ran",
  );
  assert.ok(!existsSync(join(dir, ".auto-update.json.lock")), "lock released");
  const st = JSON.parse(readFileSync(join(dir, ".auto-update.json"), "utf8"));
  assert.ok(Date.parse(st.lastRun), "lastRun is a real timestamp");
});

test("TTL: recent lastRun skips all work", async () => {
  const dir = setup(new Date().toISOString());
  const ext = await freshExtension(dir);
  const pi = makePi();
  ext(pi);
  await pi.emit("session_start", {}, makeCtx());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pi.execCalls.length, 0);
});

test("lock present: another session owns the update, return early", async () => {
  const dir = setup();
  mkdirSync(join(dir, ".auto-update.json.lock"));
  const ext = await freshExtension(dir);
  const pi = makePi();
  ext(pi);
  await pi.emit("session_start", {}, makeCtx());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pi.execCalls.length, 0);
  assert.ok(!existsSync(join(dir, ".auto-update.json")), "no state written by loser");
});

test("session_start notifies only when something changed", async () => {
  const dir = setup();
  const ext = await freshExtension(dir);
  const pi = makePi({
    execImpl: async (_c: string, args: string[]) => ({
      code: 0,
      stdout: args.includes("--self") ? "pi is already up to date" : "Updating pkg-a\nDone",
      stderr: "",
    }),
  });
  ext(pi);
  const ctx = makeCtx();
  await pi.emit("session_start", {}, ctx);
  await eventually(() => ctx.notes.length > 0);
  assert.equal(ctx.notes[0].msg, "auto-update: packages updated — /reload to apply");
  assert.equal(ctx.notes[0].level, "info");
  assert.equal(ctx.reloads, 0, "session_start never reloads");
});

test("/update: extension change triggers reload; clean run does not", async () => {
  const dir = setup();
  const ext = await freshExtension(dir);
  let extStdout = "Updating pkg-a\nDone";
  const pi = makePi({
    execImpl: async (_c: string, args: string[]) => ({
      code: 0,
      stdout: args.includes("--self") ? "already up to date" : extStdout,
      stderr: "",
    }),
  });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.update.handler("", ctx);
  assert.equal(ctx.reloads, 1, "extChanged → reload");
  assert.ok(ctx.notes.some((n: any) => n.msg.includes("packages updated")));

  extStdout = "All packages up to date";
  const ctx2 = makeCtx();
  await pi.commands.update.handler("", ctx2);
  assert.equal(ctx2.reloads, 0);
  assert.ok(ctx2.notes.some((n: any) => n.msg === "Everything up to date."));
});

test("/update: headless ctx returns without doing anything", async () => {
  const dir = setup();
  const ext = await freshExtension(dir);
  const pi = makePi();
  ext(pi);
  const ctx = makeCtx();
  ctx.hasUI = false;
  await pi.commands.update.handler("", ctx);
  assert.equal(pi.execCalls.length, 0);
});
