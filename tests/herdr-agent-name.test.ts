// herdr-agent-name.ts: a named pi session renames its herdr agent (pane) and, when it owns a tab,
// the tab too; each rename is retried independently and passes never overlap. All herdr calls are
// fake pi.exec records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePi, makeCtx } from "./harness.mjs";
import herdrAgentName from "../pi-agent/extensions/herdr-agent-name.ts";

const AGENT = ["herdr", "agent", "rename", "wH:p1", "my-session"];
const TAB = ["herdr", "tab", "rename", "wH:t1", "my-session"];
const OK = { code: 0, stdout: "", stderr: "" };
const tick = () => new Promise((r) => setImmediate(r));

// The extension reads env when installed; pin the herdr identity per test (tab optional).
function install(opts: { tab?: boolean; execImpl?: (cmd: string, args: string[]) => Promise<unknown> } = {}) {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "wH:p1";
  delete process.env.HERDR_BIN_PATH; // tests run inside herdr too; expect the bare binary name
  if (opts.tab) process.env.HERDR_TAB_ID = "wH:t1";
  else delete process.env.HERDR_TAB_ID;
  const pi = makePi({ sessionName: "my-session", execImpl: opts.execImpl });
  herdrAgentName(pi);
  return pi;
}

// Fake herdr where the given subcommand ("agent" | "tab") fails while `failing.has(it)`.
const failOn = (failing: Set<string>) => async (_c: string, args: string[]) => ({ ...OK, code: failing.has(args[0]) ? 1 : 0 });

test("named session with a tab: agent rename then tab rename; same name again runs nothing", async () => {
  const pi = install({ tab: true });
  const ctx = makeCtx();
  await pi.emit("session_start", { reason: "launch" }, ctx);
  assert.deepEqual(pi.execCalls, [AGENT, TAB]);
  await pi.emit("session_info_changed", {}, ctx);
  assert.deepEqual(pi.execCalls, [AGENT, TAB], "same name twice → executed once");
});

test("no HERDR_TAB_ID: only the agent rename", async () => {
  const pi = install();
  await pi.emit("session_start", { reason: "launch" }, makeCtx());
  assert.deepEqual(pi.execCalls, [AGENT]);
});

test("tab rename fails: agent rename is not retried, tab rename is retried on the next event", async () => {
  const failing = new Set(["tab"]);
  const pi = install({ tab: true, execImpl: failOn(failing) });
  const ctx = makeCtx();
  await pi.emit("session_start", { reason: "launch" }, ctx);
  assert.deepEqual(pi.execCalls, [AGENT, TAB]);
  failing.clear();
  await pi.emit("session_info_changed", {}, ctx);
  assert.deepEqual(pi.execCalls, [AGENT, TAB, TAB]);
  await pi.emit("session_info_changed", {}, ctx);
  assert.deepEqual(pi.execCalls, [AGENT, TAB, TAB], "settled: nothing more");
});

test("agent rename fails: tab is not renamed until the agent rename succeeds", async () => {
  const failing = new Set(["agent"]);
  const pi = install({ tab: true, execImpl: failOn(failing) });
  const ctx = makeCtx();
  await pi.emit("session_start", { reason: "launch" }, ctx);
  assert.deepEqual(pi.execCalls, [AGENT]);
  failing.clear();
  await pi.emit("session_info_changed", {}, ctx);
  assert.deepEqual(pi.execCalls, [AGENT, AGENT, TAB]);
});

test("overlapping events (pi emits without awaiting): one pass at a time, a pending agent rename is not taken for done", async () => {
  const pending: Array<(r: typeof OK) => void> = []; // agent renames resolve only when the test says so
  const pi = install({
    tab: true,
    execImpl: (_c: string, args: string[]) => (args[0] === "agent" ? new Promise((r) => pending.push(r)) : Promise.resolve(OK)),
  });
  const ctx = makeCtx();
  const first = pi.emit("session_start", { reason: "launch" }, ctx);
  const second = pi.emit("session_info_changed", {}, ctx);
  await tick();
  assert.deepEqual(pi.execCalls, [AGENT], "second pass waits; no tab rename while the agent rename is pending");
  pending.shift()!({ ...OK, code: 1 }); // first agent rename fails → second pass retries it instead of renaming the tab
  await first;
  await tick();
  assert.deepEqual(pi.execCalls, [AGENT, AGENT]);
  pending.shift()!(OK);
  await second;
  assert.deepEqual(pi.execCalls, [AGENT, AGENT, TAB]);
});

test("no UI (print-mode child inheriting the herdr env): nothing executed", async () => {
  const pi = install({ tab: true });
  const ctx = makeCtx();
  ctx.hasUI = false;
  await pi.emit("session_start", { reason: "launch" }, ctx);
  await pi.emit("session_info_changed", {}, ctx);
  assert.deepEqual(pi.execCalls, []);
});
