// herdr-fleet.ts: /fleet renders sorted live agent status; /delegate spawns
// a named workspace and prompts it. All herdr calls are fake pi.exec records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePi, makeCtx } from "./harness.mjs";
import herdrFleet from "../pi-agent/extensions/herdr-fleet.ts";

const agentsReply = (agents: unknown) => ({
  code: 0,
  stdout: JSON.stringify({ result: { agents } }),
  stderr: "",
});

test("/fleet: sorts working<idle<done, icons, ~ for $HOME", async () => {
  const pi = makePi({
    execImpl: async () =>
      agentsReply([
        { name: "zeta", agent_status: "done", cwd: "/tmp/z" },
        { name: "alpha", agent_status: "working", cwd: "/tmp/a", focused: true },
        { name: "mid", agent_status: "idle", cwd: "/tmp/m" },
      ]),
  });
  herdrFleet(pi);
  const ctx = makeCtx();
  await pi.commands.fleet.handler("", ctx);
  const lines = ctx.notes[0].msg.split("\n");
  assert.deepEqual(
    lines.map((l: string) => l.trim()),
    ["→ ⚙ alpha  /tmp/a", "○ mid  /tmp/m", "✓ zeta  /tmp/z"],
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

test("/delegate: workspace → pane → agent start --name → prompt --wait (no settle; herdr ≥0.9)", async () => {
  const pi = makePi({
    execImpl: async (_c: string, args: string[]) => {
      if (args[0] === "workspace")
        return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "p9" } } }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
    },
  });
  herdrFleet(pi);
  const ctx = makeCtx();
  await pi.commands.delegate.handler("scout fix the flake", ctx);
  assert.deepEqual(pi.execCalls, [
    ["herdr", "workspace", "create", "--cwd", process.cwd(), "--label", "scout"],
    // --name: session name = herdr agent name = intercom address
    ["herdr", "agent", "start", "scout", "--kind", "pi", "--pane", "p9", "--timeout", "60000", "--", "--name", "scout", "--thinking", "max"],
    ["herdr", "agent", "prompt", "scout", "fix the flake", "--wait"],
  ]);
  assert.ok(ctx.notes.at(-1).msg.includes("🐑 scout delegated"));
});

test("/delegate: workspace without pane_id → error notify", async () => {
  const pi = makePi({
    execImpl: async () => ({ code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" }),
  });
  herdrFleet(pi);
  const ctx = makeCtx();
  await pi.commands.delegate.handler("x do thing", ctx);
  assert.equal(ctx.notes.at(-1).level, "error");
  assert.ok(ctx.notes.at(-1).msg.includes("no pane_id"));
});

const wsExec = (existing: string[]) => async (_c: string, args: string[]) => {
  if (args[0] === "workspace" && args[1] === "list")
    return { code: 0, stdout: JSON.stringify({ result: { workspaces: existing.map((label) => ({ label })) } }), stderr: "" };
  if (args[0] === "workspace" && args[1] === "create")
    return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "p3" } } }), stderr: "" };
  return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
};

test("/ws <slug>: skips the model, de-dupes the label, starts pi --name (no prompt)", async () => {
  const pi = makePi({ execImpl: wsExec(["fix-flaky-tests"]) });
  herdrFleet(pi);
  const ctx = makeCtx();
  await pi.commands.ws.handler("fix-flaky-tests", ctx);
  assert.deepEqual(pi.execCalls, [
    ["herdr", "workspace", "list"],
    ["herdr", "workspace", "create", "--cwd", process.cwd(), "--label", "fix-flaky-tests-2"],
    ["herdr", "agent", "start", "fix-flaky-tests-2", "--kind", "pi", "--pane", "p3", "--timeout", "60000", "--", "--name", "fix-flaky-tests-2"],
  ]);
  assert.ok(ctx.notes.at(-1).msg.includes("fix-flaky-tests-2"));
});

test("/ws <prose>: asks the session model for the name, slugifies its reply", async () => {
  const pi = makePi({ execImpl: wsExec([]) });
  herdrFleet(pi);
  const ctx = makeCtx();
  ctx.modelRegistry = {
    getApiKeyAndHeaders: async () => ({ ok: true, headers: { h: "1" }, env: { E: "x" } }),
    getProvider: () => ({
      stream: (_m: unknown, req: any, opts: any) => {
        assert.equal(req.systemPrompt.includes("Never the repository name"), true);
        assert.deepEqual(opts.env, { E: "x" });
        return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: " Fix Flaky Mac Tests.\n" }] }) };
      },
    }),
  };
  await pi.commands.ws.handler("the mac tests keep flaking in CI", ctx);
  assert.equal(pi.execCalls[1][6], "fix-flaky-mac-tests");
});

test("/ws with no args and no user messages → error, nothing created", async () => {
  const pi = makePi({ execImpl: wsExec([]) });
  herdrFleet(pi);
  const ctx = makeCtx();
  ctx.sessionManager = { getBranch: () => [] };
  await pi.commands.ws.handler("", ctx);
  assert.equal(ctx.notes[0].level, "error");
  assert.equal(pi.execCalls.length, 0);
});
