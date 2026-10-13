import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { setAgentDir } from "./stubs/pi-coding-agent.mjs";
import { makePi, makeCtx } from "./harness.mjs";
import { mktmp } from "./fixture.ts";
import costs from "../extensions/costs.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const usage = (dollars: number, tokens = 10) => ({ input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: dollars, output: 0, cacheRead: 0, cacheWrite: 0, total: dollars } });
const entry = (n: number, dollars: number, tokens = 10) => ({ type: "message", id: `a${String(n).padStart(7, "0")}`, parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", provider: "invented", model: "test", stopReason: "stop", usage: usage(dollars, tokens), content: [{ type: "text", text: "NEVER RETAIN TRANSCRIPT" }] } });
const custom = (n: number, customType: string, data: object) => ({ type: "custom", id: `c${String(n).padStart(7, "0")}`, customType, data });
const contribution = (session: string, e: ReturnType<typeof entry>) => ({ id: `${session}:${e.id}`, provider: "invented", model: "test", usage: e.message.usage });

function fixture() {
  const agent = mktmp("workstream-costs");
  const sessions = join(agent, "sessions");
  const cwd = join(agent, "project");
  mkdirSync(cwd);
  const root = join(sessions, "--project--", `2026-01-01T00-00-00-000Z_${id(1)}.jsonl`);
  let rootEntries: object[] = [entry(1, 1)];
  const header = (session: string, extras = {}) => ({ type: "session", version: 3, id: session, cwd, timestamp: "2026-01-01T00:00:00Z", ...extras });
  const native = (file: string, session: string, entries: object[], extras = {}) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, [header(session, extras), ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
  };
  const pane = (n: number, entries: object[], extras = {}) => {
    const file = join(sessions, "--child--", `2026-01-01T00-00-00-000Z_${id(n)}.jsonl`);
    native(file, id(n), entries, extras);
    rootEntries.push(custom(n, "fleet-launch", { ownerSessionId: id(1), ownerSessionFile: root, childSessionId: id(n), launchId: id(n + 100), name: `coder-${n}`, role: "coder", phase: "prompted", paneId: `pane-${n}`, cwd }));
    return file;
  };
  const run = (n: number, owner = root, ownerId = id(1), entries = [entry(n, n)], source?: string) => {
    const file = source ?? join(dirname(owner), basename(owner, ".jsonl"), id(n), "run-0", "session.jsonl");
    if (!source) native(file, id(n + 200), entries);
    const record = custom(n, "subagent-run", { ownerSessionId: ownerId, runId: id(n), children: [{ index: 0, agent: "worker", sessionFile: file }] });
    const dir = join(sessions, "subagent-runs", id(n));
    mkdirSync(dir, { recursive: true });
    const json = (name: string, value: object) => writeFileSync(join(dir, name), JSON.stringify(value));
    json("launch.json", { id: id(n), runtimeVersion: 2, sessionId: ownerId, rootSessionId: id(999), sessionDir: join(dirname(owner), basename(owner, ".jsonl"), id(n)) });
    json("status.json", { runtimeVersion: 2, runId: id(n), sessionId: ownerId, state: "complete", steps: [{ agent: "worker", sessionFile: file }] });
    json("result.json", { recordVersion: 3, runtimeVersion: 2, id: id(n), sessionId: ownerId, results: [{ sessionFile: file, nativeSessionId: id(n + 200), accounting: { state: "complete" } }] });
    return { file, record, json, dir };
  };
  const open = (name = "test-coordinator") => {
    native(root, id(1), rootEntries);
    setAgentDir(agent);
    const pi = makePi({ sessionName: name });
    costs(pi);
    const ctx = makeCtx({ sessionFile: root, sessionId: id(1), entries: rootEntries });
    ctx.sessionManager.getHeader = () => header(id(1));
    return { pi, ctx };
  };
  return { agent, sessions, cwd, root, rootEntries, native, pane, run, header, open };
}

async function report(f: ReturnType<typeof fixture>, full = false) {
  const { pi, ctx } = f.open();
  const result = await pi.tools.agent_costs.execute("t", { mode: "workstream", full }, undefined, undefined, ctx);
  return { text: result.content[0].text as string, report: result.details.report, pi, ctx };
}

test("workstream command and tool count root, pane and continued headless usage once; compact first, full inspectable", async () => {
  const f = fixture();
  const pane = f.pane(2, [entry(2, 2)]);
  const child = f.run(3, pane, id(2), [entry(3, 3), entry(4, 4)]);
  const continued = f.run(4, pane, id(2), [], child.file);
  continued.json("result.json", { recordVersion: 3, runtimeVersion: 2, id: id(4), sessionId: id(2), results: [{ sessionFile: child.file, nativeSessionId: id(203), accounting: { state: "complete" } }] });
  f.native(pane, id(2), [entry(2, 2), child.record, continued.record]);
  const direct = f.run(5, f.root, id(1), [entry(5, 5)]);
  f.rootEntries.push(direct.record);
  const { text, report: data, pi, ctx } = await report(f);
  assert.equal(data.total, 15);
  assert.equal(data.contributions, 5);
  assert.match(text, /Coordinator own\s+\$1.00/);
  assert.match(text, /Root-owned headless\s+\$5.00/);
  assert.match(text, /Coder coder-2\s+\$2.00 own · \$9.00 recorded subtree/);
  assert.doesNotMatch(text, /worker .*00000000/);
  await pi.commands.costs.handler("workstream", ctx);
  assert.equal(pi.state.entries[0].data.text.split("\n").slice(1).join("\n"), text.split("\n").slice(1).join("\n"));
  const full = await pi.tools.agent_costs.execute("t", { mode: "workstream", full: true }, undefined, undefined, ctx);
  assert.match(full.content[0].text, /worker/);
  assert.match(full.content[0].text, new RegExp(id(3)));
  assert.match(full.content[0].text, new RegExp(id(4)));
  await pi.commands.costs.handler("workstream\tfull", ctx);
  assert.match(pi.state.entries[1].data.text, new RegExp(id(4)));
  assert.doesNotMatch(JSON.stringify(full.details), /NEVER RETAIN TRANSCRIPT|sessionFile|project/);
});

test("folded receipts, standalone subagent usage, compaction and nested folds normalize to independent dollars", async () => {
  const f = fixture();
  const c = entry(3, 3);
  const inner = { type: "message", id: "f0000001", message: { role: "toolResult", usage: usage(3), details: { parentUsage: { contributions: [contribution(id(203), c)] } } } };
  const p = f.pane(2, [entry(2, 2), inner]);
  const r = f.run(3, p, id(2), [c]);
  f.native(p, id(2), [entry(2, 2), inner, r.record]);
  f.rootEntries.push({ type: "message", id: "f0000002", message: { role: "toolResult", usage: usage(3), details: { parentUsage: { contributions: [{ id: `${id(2)}:f0000001`, usage: usage(3) }] } } } }, { type: "usage", id: "f0000003", contributionId: `subagent:${id(203)}:${c.id}`, provider: "invented", model: "test", usage: usage(3) }, { type: "compaction", id: "f0000004", usage: usage(4) }, { type: "branch_summary", id: "f0000005", usage: usage(5) });
  const data = (await report(f)).report;
  assert.equal(data.total, 15);
  assert.equal(data.nodes[0].own, 10);
  assert.equal(data.nodes.find((n: { id: string }) => n.id === id(2)).own, 2);
  assert.equal(data.nodes.find((n: { id: string }) => n.id === id(2)).subtree, 5);
  assert.equal(readFileSync(p, "utf8").includes("f0000001"), true);
});

test("inherited fork IDs are excluded, but missing or unsupported parents do not invent zero usage", async () => {
  const f = fixture();
  const parent = join(f.sessions, "--parent--", `2026-01-01T00-00-00-000Z_${id(50)}.jsonl`);
  f.native(parent, id(50), [entry(10, 10)]);
  f.pane(2, [entry(10, 10), entry(2, 2)], { parentSession: parent });
  f.pane(3, [entry(10, 10), entry(3, 3)], { parentSession: join(dirname(parent), `2026-01-01T00-00-00-000Z_${id(51)}.jsonl`) });
  f.pane(4, [entry(4, 4)], { version: 99 });
  const { text, report: data } = await report(f);
  assert.equal(data.total, 3);
  assert.match(text, /coverage incomplete/);
  assert.match(text, /unsupported/);
  assert.equal(data.nodes.find((n: { id: string }) => n.id === id(3)).own, null);
});

test("owned missing, unpriced and running records remain visible; failed-before-pane is not started", async () => {
  const f = fixture();
  f.rootEntries.splice(0, 1, entry(1, 0, 10), entry(2, 0, 0), { type: "usage", id: "badusage" });
  const r = f.run(3, f.root, id(1), [entry(3, 3)]);
  r.json("status.json", { runtimeVersion: 2, runId: id(3), sessionId: id(1), state: "running", steps: [{ sessionFile: r.file }] });
  r.json("result.json", { recordVersion: 3, runtimeVersion: 2, id: id(3), sessionId: id(1), results: [{ sessionFile: r.file, nativeSessionId: id(203), accounting: { state: "incomplete" } }] });
  f.rootEntries.push(r.record, custom(9, "fleet-launch", { ownerSessionId: id(1), ownerSessionFile: f.root, childSessionId: id(9), launchId: id(109), name: "unstarted", role: "coder", phase: "failed-before-pane", cwd: f.cwd }));
  const { text, report: data } = await report(f);
  assert.equal(data.total, 3);
  assert.match(text, /usage so far/);
  assert.match(text, /unpriced/);
  assert.match(text, /not started · failed before pane start/);
  assert.ok(data.flags.includes("missing"));
  assert.ok(data.flags.includes("unknown"));
  assert.ok(data.flags.includes("incomplete"));
  unlinkSync(join(r.dir, "result.json"));
  const live = await report(f);
  assert.equal(live.report.total, 3, "running cost comes from finalized native usage without a result");
  assert.ok(live.report.flags.includes("in-flight"));
});

test("copied/moved same-ID owners and foreign direct owners cannot adopt headless or pane histories", async () => {
  const f = fixture();
  const original = join(dirname(f.root), `2025-01-01T00-00-00-000Z_${id(1)}.jsonl`);
  const r = f.run(3, original, id(1), [entry(3, 300)]);
  f.rootEntries.push(r.record);
  f.pane(2, [entry(2, 200)]);
  f.rootEntries[f.rootEntries.length - 1] = custom(2, "fleet-launch", { ownerSessionId: id(1), ownerSessionFile: original, childSessionId: id(2), launchId: id(102), name: "copied", role: "coder", phase: "prompted", cwd: f.cwd });
  const foreign = f.run(4);
  foreign.json("launch.json", { runtimeVersion: 2, id: id(4), sessionId: id(99), rootSessionId: id(1) });
  f.rootEntries.push(foreign.record);
  const { report: data, text } = await report(f);
  assert.equal(data.total, 1);
  assert.match(text, /coverage incomplete/);
  assert.ok(data.nodes.some((n: { issues: string[] }) => n.issues.some(i => /ownership/.test(i))));
  assert.ok(data.flags.includes("incomplete"));
});

test("record-derived traversal and symlink escapes are denied before any target read; parser diagnostics are safe", async (t) => {
  const f = fixture();
  const outside = join(f.agent, "private.jsonl");
  writeFileSync(outside, "TOP SECRET MALFORMED CONTENT\n");
  const r = f.run(3);
  writeFileSync(r.file, "{SECRET PARSER MESSAGE\n");
  const escape = join(dirname(r.file), "escape.jsonl");
  symlinkSync(outside, escape);
  f.rootEntries.push(r.record, custom(4, "subagent-run", { runId: "../../private", ownerSessionId: id(1) }));
  const s = f.run(5, f.root, id(1), [], escape);
  f.rootEntries.push(s.record);
  const symlink = f.run(6);
  unlinkSync(symlink.file);
  symlinkSync(outside, symlink.file);
  symlink.json("status.json", { runtimeVersion: 2, runId: id(6), sessionId: id(1), state: "running", steps: [{ sessionFile: symlink.file }] });
  f.rootEntries.push(symlink.record);
  const opened: string[] = [], original = fs.openSync;
  t.mock.method(fs, "openSync", (path: Parameters<typeof fs.openSync>[0], flags: Parameters<typeof fs.openSync>[1], mode?: Parameters<typeof fs.openSync>[2]) => {
    opened.push(String(path));
    return original(path, flags, mode);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { text, report: data } = await report(f, true);
  assert.equal(data.total, 1);
  assert.match(text, /denied|invalid source/);
  assert.match(text, /line 1/);
  assert.doesNotMatch(JSON.stringify(data) + text, /TOP SECRET|SECRET PARSER|private.jsonl/);
  const denied = data.nodes.find((n: { runs: { id: string }[] }) => n.runs.some(r => r.id === id(6)));
  assert.ok(denied.issues.some((i: string) => i.startsWith("denied")), "the escaped target must be denied before JSON parsing");
  assert.equal(opened.includes(outside), false, "no open of the escaped target, even before the parser");
});

test("only incomplete trailing JSON is ignored; complete unterminated records still count", async () => {
  const f = fixture();
  const r = f.run(3, f.root, id(1), [entry(3, 3)]);
  writeFileSync(r.file, readFileSync(r.file, "utf8") + JSON.stringify(entry(4, 4)));
  f.rootEntries.push(r.record);
  assert.equal((await report(f)).report.total, 8);
  writeFileSync(r.file, readFileSync(r.file, "utf8") + "\n{\"partial");
  assert.equal((await report(f)).report.total, 8);
  writeFileSync(r.file, readFileSync(r.file, "utf8") + "\n");
  const bad = await report(f);
  assert.ok(bad.report.flags.includes("incomplete"));
  writeFileSync(r.file, readFileSync(r.file, "utf8").split("\n{\"partial")[0] + "\n{INVALID");
  assert.ok((await report(f)).report.flags.includes("incomplete"), "invalid final JSON is not a partial publish");
});

test("fold conflicts and cycles mark accounting incomplete rather than inflating known dollars", async () => {
  const f = fixture();
  const c = entry(3, 3);
  f.rootEntries.push(f.run(3, f.root, id(1), [c]).record, { type: "message", id: "receipt1", message: { role: "toolResult", usage: usage(4), details: { parentUsage: { contributions: [contribution(id(203), entry(3, 4))] } } } }, { type: "message", id: "cycle001", message: { role: "toolResult", usage: usage(5), details: { parentUsage: { contributions: [{ id: `${id(1)}:cycle001`, usage: usage(5) }] } } } });
  const { report: data } = await report(f);
  assert.equal(data.total, 1);
  assert.ok(data.flags.includes("incomplete"));
});

test("a pane receipt cannot allocate a sibling's native contribution into both subtree rows", async () => {
  const f = fixture();
  const c = entry(3, 3);
  f.rootEntries.push(f.run(3, f.root, id(1), [c]).record);
  f.pane(2, [entry(2, 2), { type: "message", id: "receipt1", message: { role: "toolResult", usage: usage(3), details: { parentUsage: { contributions: [contribution(id(203), c)] } } } }]);
  const { report: data } = await report(f);
  assert.equal(data.total, 6);
  assert.equal(data.nodes.find((n: { id: string }) => n.id === id(2)).subtree, 2);
  assert.ok(data.flags.includes("incomplete"));
});

test("headless-under-headless uses immediate ownership, preserves canonical continuations, and leaves native sources unchanged", async () => {
  const f = fixture();
  const first = f.run(3, f.root, id(1), [entry(3, 3)]);
  const nested = f.run(4, first.file, id(203), [entry(4, 4)]);
  f.native(first.file, id(203), [entry(3, 3), nested.record]);
  f.rootEntries.push(first.record);
  const before = readFileSync(first.file, "utf8");
  const { report: data } = await report(f, true);
  assert.equal(data.total, 8);
  assert.equal(data.nodes.find((n: { id: string }) => n.id === id(203)).subtree, 7);
  assert.equal(data.nodes.find((n: { id: string }) => n.id === id(204)).own, 4);
  assert.equal(readFileSync(first.file, "utf8"), before);
});

test("root own stays ready and complete when descendant usage is missing, running or unpriced", async () => {
  const f = fixture();
  const pane = f.pane(2, [entry(2, 2), { type: "usage", id: "missing2" }]);
  const nested = f.run(4, pane, id(2), [entry(4, 4)]);
  nested.json("status.json", { runtimeVersion: 2, runId: id(4), sessionId: id(2), state: "running", steps: [{ sessionFile: nested.file }] });
  unlinkSync(join(nested.dir, "result.json"));
  f.native(pane, id(2), [entry(2, 2), { type: "usage", id: "missing2" }, nested.record]);
  f.rootEntries.push(f.run(3, f.root, id(1), [entry(3, 0)]).record);
  const { pi, ctx } = f.open();
  const old = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  try {
    pi.execImpl = async () => ({ code: 0, stdout: JSON.stringify({ result: { agents: [
      { agent_status: "idle", agent_session: { kind: "id", value: id(1) } },
      { pane_id: "pane-2", agent_status: "idle", agent_session: { kind: "id", value: id(2) } },
    ] } }), stderr: "" });
    const result = await pi.tools.agent_costs.execute("t", { mode: "workstream" }, undefined, undefined, ctx);
    const text = result.content[0].text as string;
    assert.match(text, /^Coordinator own  \$1.00 · ready$/m);
    assert.deepEqual(result.details.report.nodes[0].flags, []);
    assert.match(text, /^Recorded total  \$7.00 estimated · usage so far · coverage incomplete$/m);
    assert.match(text, /^Coder coder-2 .*child work running · missing$/m);
    assert.match(text, /^Root-owned headless  unknown · 1 completed runs · coverage incomplete$/m);
  } finally {
    if (old === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = old;
  }
});

test("standard finalized and running fork-context headless sources count only new usage without needing a result", async () => {
  const f = fixture();
  for (const n of [3, 4]) {
    const file = join(dirname(f.root), `2026-01-02T00-00-00-000Z_${id(n + 200)}.jsonl`);
    f.native(file, id(n + 200), [entry(1, 1), entry(n, n)], { parentSession: f.root });
    const r = f.run(n, f.root, id(1), [], file);
    if (n === 4) {
      r.json("status.json", { runtimeVersion: 2, runId: id(n), sessionId: id(1), state: "running", steps: [{ agent: "oracle", sessionFile: file }] });
      unlinkSync(join(r.dir, "result.json"));
    }
    f.rootEntries.push(r.record);
  }
  const { report: data, text } = await report(f, true);
  assert.equal(data.total, 8);
  assert.equal(data.contributions, 3);
  assert.equal(data.nodes.find((n: { id: string }) => n.id === id(203)).own, 3);
  assert.equal(data.nodes.find((n: { id: string }) => n.id === id(204)).own, 4);
  assert.ok(data.flags.includes("in-flight"));
  assert.equal(data.flags.includes("incomplete"), false);
  assert.doesNotMatch(text, /Folded child usage|file-bound ownership unavailable/);
  const dir = join(f.sessions, "subagent-runs", id(3));
  const finalizedFile = join(dirname(f.root), `2026-01-02T00-00-00-000Z_${id(203)}.jsonl`);
  writeFileSync(join(dir, "result.json"), JSON.stringify({ recordVersion: 3, runtimeVersion: 2, id: id(3), sessionId: id(1), results: [{ sessionFile: finalizedFile, accounting: { state: "complete" } }] }));
  assert.equal((await report(f)).report.total, 8, "a finalized result's optional native identity is not required");
});

test("fork admission requires recorded ownership, immediate parent binding and native filename/result identity", async (t) => {
  for (const control of ["foreign parent", "copied same-ID owner", "sibling directory", "filename identity", "result identity", "foreign launch", "unrecorded fork"]) {
    await t.test(control, async () => {
      const f = fixture();
      const parent = control === "copied same-ID owner"
        ? join(dirname(f.root), `2025-01-01T00-00-00-000Z_${id(1)}.jsonl`)
        : control === "foreign parent" ? join(dirname(f.root), `2026-01-01T00-00-00-000Z_${id(77)}.jsonl`) : f.root;
      if (parent !== f.root) f.native(parent, control === "copied same-ID owner" ? id(1) : id(77), [entry(1, 1)]);
      const folder = control === "sibling directory" ? join(f.sessions, "--sibling--") : dirname(f.root);
      const file = join(folder, `2026-01-02T00-00-00-000Z_${id(203)}.jsonl`);
      f.native(file, control === "filename identity" ? id(204) : id(203), [entry(3, 300)], { parentSession: parent });
      const r = f.run(3, f.root, id(1), [], file);
      if (control === "filename identity") {
        r.json("status.json", { runtimeVersion: 2, runId: id(3), sessionId: id(1), state: "running", steps: [{ sessionFile: file }] });
        unlinkSync(join(r.dir, "result.json"));
      }
      if (control === "result identity") r.json("result.json", { recordVersion: 3, runtimeVersion: 2, id: id(3), sessionId: id(1), results: [{ sessionFile: file, nativeSessionId: id(999), accounting: { state: "complete" } }] });
      if (control === "foreign launch") r.json("launch.json", { runtimeVersion: 2, id: id(3), sessionId: id(77) });
      if (control !== "unrecorded fork") f.rootEntries.push(r.record);
      const { report: data, text } = await report(f, true);
      assert.equal(data.total, 1);
      if (control !== "unrecorded fork") {
        assert.ok(data.flags.includes("incomplete"));
        const reason = control === "foreign launch" ? /headless ownership mismatch/
          : control === "sibling directory" ? /denied source path/
          : control.endsWith("identity") ? /native run identity mismatch/ : /fork owner file mismatch/;
        assert.match(text, reason);
      } else assert.equal(data.nodes.length, 1);
    });
  }
});

test("a headless fork cannot adopt its sibling's source through matching run metadata", async () => {
  const f = fixture();
  const firstFile = join(dirname(f.root), `2026-01-02T00-00-00-000Z_${id(203)}.jsonl`);
  const siblingFile = join(dirname(f.root), `2026-01-02T00-00-00-000Z_${id(204)}.jsonl`);
  const first = f.run(3, f.root, id(1), [], firstFile);
  const sibling = f.run(4, f.root, id(1), [], siblingFile);
  const foreign = f.run(5, firstFile, id(203), [], siblingFile);
  foreign.json("result.json", { recordVersion: 3, runtimeVersion: 2, id: id(5), sessionId: id(203), results: [{ sessionFile: siblingFile, nativeSessionId: id(204), accounting: { state: "complete" } }] });
  f.native(firstFile, id(203), [entry(1, 1), entry(3, 3), foreign.record], { parentSession: f.root });
  f.native(siblingFile, id(204), [entry(1, 1), entry(4, 4)], { parentSession: f.root });
  f.rootEntries.push(first.record, sibling.record);
  const { report: data, text } = await report(f, true);
  assert.equal(data.total, 8);
  assert.equal(data.nodes.find((n: { id: string }) => n.id === id(203)).subtree, 3);
  assert.equal(data.nodes.find((n: { id: string }) => n.id === id(204)).own, 4);
  assert.match(text, /fork owner file mismatch/);
  assert.ok(data.flags.includes("incomplete"));
});

test("a standard fork filename cannot open a symlink escaping sessions", async (t) => {
  const f = fixture();
  const file = join(dirname(f.root), `2026-01-02T00-00-00-000Z_${id(203)}.jsonl`);
  const outside = join(f.agent, "private.jsonl");
  f.native(outside, id(203), [entry(3, 300)], { parentSession: f.root });
  mkdirSync(dirname(file), { recursive: true });
  symlinkSync(outside, file);
  f.rootEntries.push(f.run(3, f.root, id(1), [], file).record);
  const opened: string[] = [], original = fs.openSync;
  t.mock.method(fs, "openSync", (path: Parameters<typeof fs.openSync>[0], flags: Parameters<typeof fs.openSync>[1], mode?: Parameters<typeof fs.openSync>[2]) => {
    opened.push(String(path));
    return original(path, flags, mode);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { report: data, text } = await report(f, true);
  assert.equal(data.total, 1);
  assert.match(text, /denied source path/);
  assert.equal(opened.includes(outside), false);
});

test("unadmitted native descendants retain reconcilable folded receipts in compact and full views", async () => {
  const f = fixture();
  const child = entry(3, 7);
  const r = f.run(3, f.root, id(1), [child]);
  unlinkSync(join(r.dir, "launch.json"));
  f.rootEntries.push(r.record, { type: "message", id: "receipt1", message: {
    role: "toolResult", toolCallId: "delegate1", toolName: "delegate", usage: usage(7),
    details: { parentUsage: { state: "complete", contributions: [contribution(id(203), child)] } },
  } });
  for (const full of [false, true]) {
    const { report: data, text } = await report(f, full);
    assert.equal(data.total, 8);
    assert.equal(data.nodes[0].own, 1);
    assert.match(text, /^Folded child usage  \$7.00 · recorded without an admitted native descendant$/m);
    assert.ok(data.flags.includes("missing"));
  }
});

test("continuing a child inside an earlier multi-child group counts once and retains unique root-owned run counts", async () => {
  const f = fixture();
  const first = f.run(3, f.root, id(1), [entry(3, 3), entry(5, 5)]);
  const secondFile = join(dirname(dirname(first.file)), "run-1", "session.jsonl");
  f.native(secondFile, id(204), [entry(4, 4)]);
  first.json("status.json", { runtimeVersion: 2, runId: id(3), sessionId: id(1), state: "complete", steps: [{ sessionFile: first.file }, { sessionFile: secondFile }] });
  first.json("result.json", { recordVersion: 3, runtimeVersion: 2, id: id(3), sessionId: id(1), results: [
    { sessionFile: first.file, nativeSessionId: id(203), accounting: { state: "complete" } },
    { sessionFile: secondFile, nativeSessionId: id(204), accounting: { state: "complete" } },
  ] });
  const continued = f.run(4, f.root, id(1), [], first.file);
  continued.json("result.json", { recordVersion: 3, runtimeVersion: 2, id: id(4), sessionId: id(1), results: [{ sessionFile: first.file, nativeSessionId: id(203), accounting: { state: "complete" } }] });
  f.rootEntries.push(first.record, continued.record);
  const compact = await report(f);
  assert.equal(compact.report.total, 13);
  assert.equal(compact.report.contributions, 4);
  assert.match(compact.text, /^Root-owned headless  \$12.00 · 2 completed runs$/m);
  assert.equal(compact.report.flags.includes("incomplete"), false);
  const full = await report(f, true);
  assert.match(full.text, new RegExp(`run ${id(3)}  \\$12.00 recorded subtree`));
  assert.doesNotMatch(full.text, /duplicate or cyclic|unknown own/);
  const source = full.report.nodes.find((n: { id: string }) => n.id === id(203));
  assert.deepEqual(source.runs, [{ id: id(3), state: "complete" }, { id: id(4), state: "complete" }]);
  assert.equal(source.own, 8);
});

test("same-ID native copies cannot duplicate own rows across distinct headless source files", async () => {
  const f = fixture();
  const first = f.run(3, f.root, id(1), [entry(3, 3)]);
  const second = f.run(4);
  f.native(second.file, id(203), [entry(3, 3)]);
  second.json("result.json", { recordVersion: 3, runtimeVersion: 2, id: id(4), sessionId: id(1), results: [{ sessionFile: second.file, nativeSessionId: id(203), accounting: { state: "complete" } }] });
  f.rootEntries.push(first.record, second.record);
  const { report: data } = await report(f);
  assert.equal(data.total, 4);
  assert.equal(data.nodes.filter((n: { id: string; own: number | null }) => n.id === id(203) && n.own === 3).length, 1);
  assert.ok(data.flags.includes("incomplete"));
});

test("unknown-only sources render unknown, and unsupported run metadata is visible per node", async () => {
  const f = fixture();
  const aborted = entry(1, 0, 0);
  aborted.message.stopReason = "aborted";
  f.rootEntries.splice(0, 1, { type: "usage", id: "missing1" }, aborted);
  const r = f.run(3);
  r.json("launch.json", { id: id(3), runtimeVersion: 99, sessionId: id(1) });
  f.rootEntries.push(r.record);
  const { report: data, text } = await report(f, true);
  assert.equal(data.total, null);
  assert.match(text, /Recorded total  unknown/);
  assert.match(text, /unsupported launch version/);
  assert.ok(data.flags.includes("unsupported"));
  assert.equal(data.nodes[1].own, null);
  f.rootEntries.splice(1, 1, entry(1, 0, 10));
  const unpriced = await report(f);
  assert.equal(unpriced.report.total, null, "unpriced-only history must not imply free work");
  assert.ok(unpriced.report.flags.includes("unpriced"));
});

test("herdr activity is async, read-only, abortable and matched by pane plus native identity", async () => {
  const f = fixture();
  const p = f.pane(2, [entry(2, 2)]);
  const { pi, ctx } = f.open("root-coder");
  const old = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  try {
    let observedSignal: AbortSignal | undefined;
    pi.execImpl = async (_cmd: string, _args: string[], opts: { signal?: AbortSignal; timeout?: number }) => {
      observedSignal = opts.signal;
      assert.equal(opts.timeout, 5000);
      return { code: 0, stdout: JSON.stringify({ result: { agents: [{ pane_id: "root-pane", agent_status: "done", agent_session: { kind: "id", value: id(1) } }, { pane_id: "pane-2", agent_status: "working", agent_session: { kind: "path", value: p } }, { pane_id: "foreign", agent_status: "blocked", agent_session: { kind: "id", value: id(2) }, cwd: "UNMATCHED PRIVATE CWD", terminal_title: "UNMATCHED PRIVATE TITLE" }] } }), stderr: "" };
    };
    const controller = new AbortController();
    const result = await pi.tools.agent_costs.execute("t", { mode: "workstream" }, controller.signal, undefined, ctx);
    assert.equal(observedSignal, controller.signal);
    assert.deepEqual(pi.execCalls, [["herdr", "agent", "list"]]);
    assert.match(result.content[0].text, /Coder own/);
    assert.match(result.content[0].text, /working/);
    assert.doesNotMatch(JSON.stringify(result.details), /UNMATCHED|foreign|terminal_title|cwd/);
    controller.abort();
    await assert.rejects(pi.tools.agent_costs.execute("t", { mode: "workstream" }, controller.signal, undefined, ctx), /abort/i);
    assert.equal(pi.execCalls.length, 1);
    pi.execImpl = async () => ({ code: 1, stdout: "PRIVATE ERROR", stderr: "PRIVATE ERROR" });
    const failure = await pi.tools.agent_costs.execute("t", { mode: "workstream" }, undefined, undefined, ctx);
    assert.match(failure.content[0].text, /activity unavailable/);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE ERROR/);
    const during = new AbortController();
    pi.execImpl = async (_cmd: string, _args: string[], opts: { signal: AbortSignal }) => {
      during.abort();
      assert.ok(opts.signal.aborted);
      return { code: 0, stdout: "PRIVATE ABORTED OUTPUT", stderr: "" };
    };
    await assert.rejects(pi.tools.agent_costs.execute("t", { mode: "workstream" }, during.signal, undefined, ctx), /abort/i);
  } finally {
    if (old === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = old;
  }
});
