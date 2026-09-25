// herdr-fleet.ts: /fleet renders sorted live agent status; /delegate spawns
// a named tab in the caller's workspace and prompts it. All herdr calls are fake pi.exec records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePi, makeCtx } from "./harness.mjs";
import herdrFleet from "../extensions/herdr-fleet.ts";

const agentsReply = (agents: unknown) => ({
  code: 0,
  stdout: JSON.stringify({ result: { agents } }),
  stderr: "",
});

// The extension identifies "me" by HERDR_PANE_ID; pin it so tests are the same inside and outside herdr.
process.env.HERDR_PANE_ID = "wH:p1";
const ME = { name: "coordinator-test", agent_status: "idle", cwd: "/tmp/me", pane_id: "wH:p1", workspace_id: "wH" };
// Children are addressed to my intercom ID (pi-<sha256(session id)[0:32]>), never my name, which can change.
// sha256("fleet-sess").hex[0:32], precomputed so the test does not share the implementation's formula.
const SESSION_ID = "fleet-sess";
const MY_ID = "pi-8271896c98088f150f678afd3ae5249e";
const fleetCtx = () => makeCtx({ sessionId: SESSION_ID });
const tabReply = { code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "wH:t2" }, root_pane: { pane_id: "wH:p2" } } }), stderr: "" };

test("/fleet: sorts working<idle<done, icons; same-workspace agents are [mine], me and other workspaces [yours]", async () => {
  const pi = makePi({
    execImpl: async () =>
      agentsReply([
        { name: "zeta", agent_status: "done", cwd: "/tmp/z", pane_id: "w2:p1", workspace_id: "w2" },
        { name: "alpha", agent_status: "working", cwd: "/tmp/a", focused: true, pane_id: "wH:p2", workspace_id: "wH" },
        ME,
      ]),
  });
  herdrFleet(pi);
  const ctx = makeCtx();
  await pi.commands.fleet.handler("", ctx);
  const lines = ctx.notes[0].msg.split("\n");
  assert.deepEqual(
    lines.map((l: string) => l.trim()),
    ["→ ⚙ alpha  /tmp/a  [mine]", "○ coordinator-test  /tmp/me  [yours]", "✓ zeta  /tmp/z  [yours]"],
  );
  assert.deepEqual(pi.execCalls, [["herdr", "agent", "list"]]);
});

test("/fleet: empty roster and herdr failure both notify", async () => {
  const pi = makePi({ execImpl: async () => agentsReply([]) });
  herdrFleet(pi);
  const ctx = makeCtx();
  await pi.commands.fleet.handler("", ctx);
  assert.equal(ctx.notes[0].msg, "No herdr agents found.");

  const pi2 = makePi({ execImpl: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
  herdrFleet(pi2);
  const ctx2 = makeCtx();
  await pi2.commands.fleet.handler("", ctx2);
  assert.equal(ctx2.notes[0].level, "error");
  assert.ok(ctx2.notes[0].msg.startsWith("fleet: herdr agent list failed: boom"));
});

test("/delegate: usage error without name+task", async () => {
  const pi = makePi();
  herdrFleet(pi);
  const ctx = makeCtx();
  await pi.commands.delegate.handler("solo", ctx);
  assert.deepEqual(ctx.notes[0], { msg: "Usage: /delegate <name> <task>", level: "error" });
  assert.equal(pi.execCalls.length, 0);
});

test("/delegate: task without an `Owner outcome:` block is refused before anything is spawned", async () => {
  const pi = makePi({ execImpl: delegateExec([ME]) });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("scout fix the flake", ctx);
  assert.equal(ctx.notes.at(-1).level, "error");
  assert.ok(ctx.notes.at(-1).msg.includes("Owner outcome:"), ctx.notes.at(-1).msg);
  assert.equal(pi.execCalls.length, 0);
});

test("/delegate: task without `Approved mock:` or `Mock: skipped:` is refused before anything is spawned", async () => {
  const pi = makePi({ execImpl: delegateExec([ME]) });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("scout Owner outcome: fix the flake", ctx);
  assert.equal(ctx.notes.at(-1).level, "error");
  assert.ok(ctx.notes.at(-1).msg.includes("Approved mock:"), ctx.notes.at(-1).msg);
  assert.ok(ctx.notes.at(-1).msg.includes("shape skill"), ctx.notes.at(-1).msg);
  assert.equal(pi.execCalls.length, 0);
  // an inline mention is not a block
  await pi.commands.delegate.handler("scout Owner outcome: fix the flake\nsee the Approved mock: below", ctx);
  assert.equal(pi.execCalls.length, 0);
  // approved mock passes the gate
  await pi.commands.delegate.handler("scout Owner outcome: fix the flake\nApproved mock:\n  $ x\n  ok", ctx);
  assert.equal(pi.execCalls[0]?.[1], "agent");
});

// Fake herdr for /delegate: `agent list` returns the given roster, `tab create` a tab+pane, everything else {}.
const delegateExec = (roster: unknown[]) => async (_c: string, args: string[]) => {
  if (args[0] === "agent" && args[1] === "list") return agentsReply(roster);
  if (args[0] === "tab") return tabReply;
  return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
};

test("/delegate: agent list → tab in MY workspace → agent start --name → prompt --wait --until working (task + report-to-my-ID/close contract)", async () => {
  const pi = makePi({ execImpl: delegateExec([ME]) });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("scout Owner outcome: fix the flake\nMock: skipped: no user-visible surface", ctx);
  assert.deepEqual(pi.execCalls.slice(0, 3), [
    ["herdr", "agent", "list"],
    // a tab in the caller's workspace (grouped sidebar nests it under the caller), never a new workspace;
    // the spawner is identified by intercom ID, not by its (renamable) session name
    ["herdr", "tab", "create", "--workspace", "wH", "--cwd", process.cwd(), "--label", "scout", "--no-focus", "--env", `PI_SPAWNED_BY=${MY_ID}`],
    // --name: the child's human name (session name = herdr agent name)
    ["herdr", "agent", "start", "scout", "--kind", "pi", "--pane", "wH:p2", "--timeout", "60000", "--", "--name", "scout", "--thinking", "max"],
  ]);
  const [prompt, ...rest] = pi.execCalls[3].slice(4);
  assert.deepEqual([pi.execCalls[3].slice(0, 4), rest], [["herdr", "agent", "prompt", "scout"], ["--wait", "--until", "working", "--timeout", "10000"]]);
  assert.ok(prompt.startsWith("Owner outcome: fix the flake\nMock: skipped: no user-visible surface\n\n"), prompt);
  assert.ok(prompt.includes("`Approved mock:` is the acceptance criterion"), prompt);
  assert.ok(prompt.includes("Copy both blocks unchanged into every subagent brief"), prompt);
  assert.ok(prompt.includes(`report ONCE to intercom session \`${MY_ID}\` (that is your spawner's ID; use it verbatim)`), prompt);
  assert.ok(!prompt.includes("coordinator-test"), "the spawner's name is not an address");
  assert.ok(prompt.includes('herdr tab close "$HERDR_TAB_ID"'), prompt);
  assert.equal(pi.execCalls.length, 4);
  assert.ok(ctx.notes.at(-1).msg.includes("🐑 scout delegated"));
});

test("/delegate: own pane not in agent list (not inside herdr) → error, nothing created", async () => {
  const pi = makePi({ execImpl: delegateExec([{ name: "other", pane_id: "w2:p1", workspace_id: "w2" }]) });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("x Owner outcome: do thing\nMock: skipped: test", ctx);
  assert.deepEqual(pi.execCalls, [["herdr", "agent", "list"]]);
  assert.deepEqual(ctx.notes.at(-1), { msg: "delegate: /delegate needs to run inside a herdr pane", level: "error" });
});

test("/delegate: name taken by a live agent → suffixed name for label, agent and --name", async () => {
  const pi = makePi({ execImpl: delegateExec([ME, { name: "scout", pane_id: "w2:p1", workspace_id: "w2" }, { name: "scout-2", pane_id: "wH:p3", workspace_id: "wH" }]) });
  herdrFleet(pi);
  await pi.commands.delegate.handler("scout Owner outcome: go\nMock: skipped: test", fleetCtx());
  assert.equal(pi.execCalls[1][8], "scout-3"); // --label
  assert.equal(pi.execCalls[2][3], "scout-3"); // agent start <name>
  assert.equal(pi.execCalls[2][12], "scout-3"); // -- --name <name>
  assert.equal(pi.execCalls[3][3], "scout-3"); // agent prompt <name>
});

test("/delegate: tab without pane_id → error notify", async () => {
  const pi = makePi({
    execImpl: async (_c: string, args: string[]) => (args[1] === "list" ? agentsReply([ME]) : { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" }),
  });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("x Owner outcome: do thing\nMock: skipped: test", ctx);
  assert.equal(ctx.notes.at(-1).level, "error");
  assert.ok(ctx.notes.at(-1).msg.includes("no pane_id"));
});

// /ws de-dupes its name against live herdr agent names (the name is also the agent/intercom name).
const wsExec = (existing: string[]) => async (_c: string, args: string[]) => {
  if (args[0] === "agent" && args[1] === "list") return agentsReply(existing.map((name) => ({ name })));
  if (args[0] === "workspace" && args[1] === "create")
    return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "p3" } } }), stderr: "" };
  return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
};

// /ws reads ~/.pi/agent/configs/ws.json at call time; point HOME at a scratch dir with a known map.
function withWsConfig(repos: Record<string, string> | null, fn: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "ws-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  if (repos) {
    mkdirSync(join(home, ".pi/agent/configs"), { recursive: true });
    writeFileSync(join(home, ".pi/agent/configs/ws.json"), JSON.stringify({ repos }));
  }
  return fn().finally(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
}

test("/ws <repo-id> <slug>: explicit id + slug → no model call, de-duped label, pi --name in that dir", () =>
  withWsConfig({ workos: "~/work/workos" }, async () => {
    const pi = makePi({ execImpl: wsExec(["fix-flaky-tests"]) });
    herdrFleet(pi);
    const ctx = makeCtx();
    await pi.commands.ws.handler("workos fix-flaky-tests", ctx);
    assert.deepEqual(pi.execCalls, [
      ["herdr", "agent", "list"],
      ["herdr", "workspace", "create", "--cwd", `${process.env.HOME}/work/workos`, "--label", "fix-flaky-tests-2"],
      ["herdr", "agent", "start", "fix-flaky-tests-2", "--kind", "pi", "--pane", "p3", "--timeout", "60000", "--", "--name", "fix-flaky-tests-2"],
    ]);
  }));

test("/ws <prose>: model picks name AND repo from the configured ids only", () =>
  withWsConfig({ workos: "~/work/workos", pawprint: "~/work/pawprint" }, async () => {
    const pi = makePi({ execImpl: wsExec([]) });
    herdrFleet(pi);
    const ctx = makeCtx();
    // pi's Provider.stream ignores a raw `systemPrompt` field — the persona must arrive
    // normalized (normalizeContext) as the leading system message, or it is silently dropped.
    // Assertions run after the handler: it catches provider-thrown errors into error notes.
    let seenReq: { systemPrompt?: string; messages: { role: string; content: string }[] } | undefined;
    let seenOpts: Record<string, unknown> | undefined;
    ctx.modelRegistry = {
      getApiKeyAndHeaders: async () => ({ ok: true, headers: { h: "1" }, env: { E: "x" } }),
      getProvider: () => ({
        stream: (_m: unknown, req: { systemPrompt?: string; messages: { role: string; content: string }[] }, opts: Record<string, unknown>) => {
          seenReq = req;
          seenOpts = opts;
          return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: 'Sure:\n{"name": "Fix Flaky Mac Tests", "repo": "workos"}' }] }) };
        },
      }),
    };
    await pi.commands.ws.handler("the mac tests keep flaking in CI", ctx);
    assert.equal(seenReq?.systemPrompt, undefined, "raw systemPrompt field is dropped by providers");
    assert.equal(seenReq?.messages[0].role, "system", "planning persona leads the transcript");
    assert.ok(seenReq?.messages[0].content.includes("workos, pawprint"));
    assert.deepEqual(seenOpts?.env, { E: "x" });
    assert.ok(seenOpts && !("reasoning" in seenOpts), "planning call must not enable reasoning");
    assert.equal(pi.execCalls[1][4], `${process.env.HOME}/work/workos`);
    assert.equal(pi.execCalls[1][6], "fix-flaky-mac-tests");
  }));

test("/ws: model can't place it / unknown repo → error, nothing created", () =>
  withWsConfig({ workos: "~/work/workos" }, async () => {
    const pi = makePi({ execImpl: wsExec([]) });
    herdrFleet(pi);
    const ctx = makeCtx();
    ctx.modelRegistry = {
      getApiKeyAndHeaders: async () => ({ ok: true }),
      getProvider: () => ({ stream: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"name":"x-y","repo":"atlas"}' }] }) }) }),
    };
    await pi.commands.ws.handler("something vague", ctx);
    assert.equal(ctx.notes[0].level, "error");
    assert.ok(ctx.notes[0].msg.includes("can't tell which repo"));
    assert.equal(pi.execCalls.length, 0);
  }));

test("/ws with no config and no dir → error naming the config file; no scan of ~/work", () =>
  withWsConfig(null, async () => {
    const pi = makePi({ execImpl: wsExec([]) });
    herdrFleet(pi);
    const ctx = makeCtx();
    await pi.commands.ws.handler("fix the thing", ctx);
    assert.equal(ctx.notes[0].level, "error");
    assert.ok(ctx.notes[0].msg.includes("configs/ws.json"));
    assert.equal(pi.execCalls.length, 0);
  }));
