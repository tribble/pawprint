// costs.ts: one session.jsonl under sessions/*/*/*/run-*/ = one run; medians per model over runs,
// sorted by run count; --days filters by mtime; a zero-token run yields 0% shares, not NaN.
// /costs appends a TUI-only "costs" entry; agent_costs returns the same text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "./stubs/pi-coding-agent.mjs";
import { makePi, makeCtx } from "./harness.mjs";
import costs, { costsTable } from "../extensions/costs.ts";

const turn = (model: string, total: number, totalTokens: number, reasoning = 0, cacheRead = 0) =>
  JSON.stringify({ type: "message", message: { role: "assistant", model, usage: { totalTokens, reasoning, cacheRead, cost: { total } } } });
const user = JSON.stringify({ type: "message", message: { role: "user", content: "hi" } });

function fixture() {
  const agent = mkdtempSync(join(tmpdir(), "costs-agent-"));
  const sessions = join(agent, "sessions");
  const run = (name: string, lines: string[], ageDays = 0) => {
    const dir = join(sessions, "--cwd--", "2026-01-01T00-00-00_sid", name.split("/")[0], `run-${name.split("/")[1]}`);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "session.jsonl");
    writeFileSync(f, lines.join("\n") + "\n{\"partial"); // truncated trailing line is skipped
    const t = (Date.now() - ageDays * 86400_000) / 1000;
    utimesSync(f, t, t);
  };
  run("a/0", [user, turn("gpt", 1, 1_000_000, 10_000, 500_000), turn("gpt", 1, 1_000_000, 10_000, 500_000)]); // 2 turns, $2, 2Mtok
  run("b/0", [user, turn("gpt", 4, 4_000_000, 0, 4_000_000)]); // $4, 1 turn, 4Mtok, 0% / 100%
  run("c/0", [user, turn("gpt", 6, 6_000_000)]); // $6
  run("d/0", [user, turn("claude", 0, 0)]); // zero tokens: must not crash
  run("e/0", [user, turn("claude", 1.5, 100, 1, 90)], 10); // old
  run("f/0", [user]); // no assistant turn: not a run
  mkdirSync(join(sessions, "--cwd--", "top-level-session"), { recursive: true });
  writeFileSync(join(sessions, "--cwd--", "top-level-session", "session.jsonl"), turn("parent", 99, 1)); // not under run-*
  setAgentDir(agent);
  return sessions;
}

test("table: medians per model over runs, sorted by run count; zero-token run gives 0%", () => {
  const out = costsTable(fixture()).split("\n");
  assert.equal(out[0], "subagent runs, all");
  assert.equal(out[1], `${"model".padEnd(45)} runs  med $ turns  Mtok reason% cache%`);
  assert.equal(out[2], `${"gpt".padEnd(45)}    3   4.00     1  4.00    0.0%  50.0%`);
  assert.equal(out[3], `${"claude".padEnd(45)}    2   0.75     1  0.00    0.5%  45.0%`);
  assert.equal(out.length, 4, "no row for the parent session or the turnless run");
});

test("days: runs older than the cutoff (mtime) are excluded; header names the window", () => {
  const out = costsTable(fixture(), 7).split("\n");
  assert.equal(out[0], "subagent runs, last 7 days");
  assert.equal(out[3], `${"claude".padEnd(45)}    1   0.00     1  0.00    0.0%   0.0%`);
});

test("/costs appends a costs entry (TUI only); bad arg → usage; agent_costs returns the same text", async () => {
  fixture();
  const pi = makePi();
  costs(pi);
  const ctx = makeCtx();
  await pi.commands.costs.handler(" 7 ", ctx);
  assert.equal(pi.state.entries.length, 1);
  assert.equal(pi.state.entries[0].type, "costs");
  assert.ok(pi.state.entries[0].data.text.startsWith("subagent runs, last 7 days\n"));
  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s };
  assert.equal(pi.entryRenderers.costs(pi.state.entries[0], {}, theme).text, pi.state.entries[0].data.text);

  await pi.commands.costs.handler("soon", ctx);
  assert.deepEqual(ctx.notes, [{ msg: "usage: /costs [days]", level: "warning" }]);
  assert.equal(pi.state.entries.length, 1);

  const r = await pi.tools.agent_costs.execute("t", { days: 7 }, undefined, undefined, ctx);
  assert.equal(r.content[0].text, pi.state.entries[0].data.text);
  const all = await pi.tools.agent_costs.execute("t", {}, undefined, undefined, ctx);
  assert.ok(all.content[0].text.startsWith("subagent runs, all\n"));
});
