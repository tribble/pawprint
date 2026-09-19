// herdr-agent-name.ts: a named pi session renames its herdr agent (pane) to the herdr-shaped slug of
// its name; once herdr accepts it, the session itself takes that slug (once; the slug is a fixed point)
// and, when it owns a tab, the tab too. Each rename is retried independently and passes never overlap.
// All herdr calls are fake pi.exec records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePi, makeCtx } from "./harness.mjs";
import herdrAgentName, { slug } from "../agent/extensions/herdr-agent-name.ts";

const AGENT = ["herdr", "agent", "rename", "wH:p1", "my-session"];
const TAB = ["herdr", "tab", "rename", "wH:t1", "my-session"];
const OK = { code: 0, stdout: "", stderr: "" };
const tick = () => new Promise((r) => setImmediate(r));

// The extension reads env when installed; pin the herdr identity per test (tab optional).
// pi.sessionName is the stored name (a test sets it directly to play the user's `/session name`);
// setSessionName mirrors pi: store the name, then emit session_info_changed without awaiting it.
function install(opts: { tab?: boolean; name?: string; execImpl?: (cmd: string, args: string[]) => Promise<unknown> } = {}) {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "wH:p1";
  delete process.env.HERDR_BIN_PATH; // tests run inside herdr too; expect the bare binary name
  if (opts.tab) process.env.HERDR_TAB_ID = "wH:t1";
  else delete process.env.HERDR_TAB_ID;
  const pi = makePi({ execImpl: opts.execImpl });
  pi.sessionName = opts.name ?? "my-session";
  pi.getSessionName = () => pi.sessionName;
  pi.setSessionNameCalls = [] as string[];
  pi.setSessionName = (n: string) => {
    pi.sessionName = n;
    pi.setSessionNameCalls.push(n);
    void pi.emit("session_info_changed", { name: n }, makeCtx());
  };
  herdrAgentName(pi);
  return pi;
}

// Fake herdr where the given subcommand ("agent" | "tab") fails while `failing.has(it)`.
const failOn = (failing: Set<string>) => async (_c: string, args: string[]) => ({ ...OK, code: failing.has(args[0]) ? 1 : 0 });

test("slug: herdr's agent-name shape", () => {
  const cases: Array<[string, string | null]> = [
    ["Workflow Improvements", "workflow-improvements"],
    ["VULN-3431 static ECR", "vuln-3431-static-ecr"],
    ["  --Deploy Issue!! ", "deploy-issue"],
    ["123abc", "abc"],
    ["snake_case keeps_underscores", "snake_case-keeps_underscores"],
    ["abcdefghijklmnopqrstuvwxyzabcde-fghijklm", "abcdefghijklmnopqrstuvwxyzabcde"], // 40 chars; cut at 32 lands on "-"
    ["!!!", null],
  ];
  for (const [input, expected] of cases) assert.equal(slug(input), expected, JSON.stringify(input));
  for (const [, s] of cases) if (s) assert.equal(slug(s), s, `fixed point: ${s}`); // what lets the session rename settle
  const long = slug("a".repeat(40))!;
  assert.equal(long.length, 32);
});

test("named session with a tab: agent rename then tab rename; same name again runs nothing", async () => {
  const pi = install({ tab: true });
  const ctx = makeCtx();
  await pi.emit("session_start", { reason: "launch" }, ctx);
  assert.deepEqual(pi.execCalls, [AGENT, TAB]);
  assert.deepEqual(pi.setSessionNameCalls, [], "already a slug: the session is not renamed");
  await pi.emit("session_info_changed", {}, ctx);
  assert.deepEqual(pi.execCalls, [AGENT, TAB], "same name twice → executed once");
});

const AGENT_WF = ["herdr", "agent", "rename", "wH:p1", "workflow-improvements"];
const TAB_WF = ["herdr", "tab", "rename", "wH:t1", "workflow-improvements"];

test("free-form session name: renamed to its slug exactly once; herdr gets the slug; the re-entry settles", async () => {
  const pi = install({ tab: true, name: "Workflow Improvements" });
  await pi.emit("session_start", { reason: "launch" }, makeCtx());
  await tick(); // the setSessionName-triggered session_info_changed pass runs after the first one
  assert.deepEqual(pi.setSessionNameCalls, ["workflow-improvements"]);
  assert.equal(pi.getSessionName(), "workflow-improvements");
  assert.deepEqual(pi.execCalls, [AGENT_WF, TAB_WF]);
});

test("herdr refuses the slug (e.g. name taken by a live agent): the session keeps its name; retried on the next event", async () => {
  const failing = new Set(["agent"]);
  const pi = install({ tab: true, name: "Workflow Improvements", execImpl: failOn(failing) });
  const ctx = makeCtx();
  await pi.emit("session_start", { reason: "launch" }, ctx);
  await tick();
  assert.deepEqual(pi.execCalls, [AGENT_WF]);
  assert.deepEqual(pi.setSessionNameCalls, [], "intercom address untouched while herdr does not own the slug");
  assert.equal(pi.getSessionName(), "Workflow Improvements");
  failing.clear();
  await pi.emit("session_info_changed", {}, ctx);
  await tick();
  assert.deepEqual(pi.execCalls, [AGENT_WF, AGENT_WF, TAB_WF]);
  assert.deepEqual(pi.setSessionNameCalls, ["workflow-improvements"]);
});

test("user renames the session while the agent rename is pending: the older slug never overwrites the newer name", async () => {
  const pending: Array<(r: typeof OK) => void> = [];
  const pi = install({
    tab: true,
    name: "Workflow Improvements",
    execImpl: (_c: string, args: string[]) => (args[0] === "agent" ? new Promise((r) => pending.push(r)) : Promise.resolve(OK)),
  });
  const ctx = makeCtx();
  const first = pi.emit("session_start", { reason: "launch" }, ctx);
  await tick();
  assert.deepEqual(pi.setSessionNameCalls, [], "the session is not renamed before herdr accepts the slug");
  pi.sessionName = "Deploy Issue"; // `/session name` mid-flight: pi stores it and emits without awaiting
  const second = pi.emit("session_info_changed", {}, ctx);
  pending.shift()!(OK); // herdr accepted "workflow-improvements", but the session has moved on
  await first;
  assert.deepEqual(pi.setSessionNameCalls, []);
  assert.equal(pi.getSessionName(), "Deploy Issue");
  await tick();
  pending.shift()!(OK);
  await second;
  await tick();
  assert.deepEqual(pi.setSessionNameCalls, ["deploy-issue"]);
  assert.equal(pi.getSessionName(), "deploy-issue");
  assert.deepEqual(pi.execCalls, [AGENT_WF, TAB_WF, ["herdr", "agent", "rename", "wH:p1", "deploy-issue"], ["herdr", "tab", "rename", "wH:t1", "deploy-issue"]]);
});

test("name with no slug (\"!!!\"): nothing renamed, nothing executed", async () => {
  const pi = install({ tab: true, name: "!!!" });
  await pi.emit("session_start", { reason: "launch" }, makeCtx());
  await tick();
  assert.deepEqual(pi.setSessionNameCalls, []);
  assert.deepEqual(pi.execCalls, []);
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
