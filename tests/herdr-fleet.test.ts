// herdr-fleet.ts: /fleet renders sorted live agent status; /delegate spawns
// a named workspace and prompts it. All herdr calls are fake pi.exec records.
import { test, mock } from "node:test";
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

test("/delegate: workspace → pane → agent start → settle → prompt --wait", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pi = makePi({
      execImpl: async (_c: string, args: string[]) => {
        if (args[0] === "workspace")
          return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "p9" } } }), stderr: "" };
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      },
    });
    herdrFleet(pi);
    const ctx = makeCtx();
    const done = pi.commands.delegate.handler("scout fix the flake", ctx);
    // the 5s settle timer is scheduled only after two awaited herdr calls;
    // flush microtasks, then tick past it in slices so late scheduling can't strand us
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setImmediate(r));
      mock.timers.tick(1000);
    }
    await done;
    assert.deepEqual(pi.execCalls, [
      ["herdr", "workspace", "create", "--cwd", process.cwd(), "--label", "scout"],
      ["herdr", "agent", "start", "scout", "--kind", "pi", "--pane", "p9", "--timeout", "60000", "--", "--thinking", "max"],
      ["herdr", "agent", "prompt", "scout", "fix the flake", "--wait"],
    ]);
    assert.ok(ctx.notes.at(-1).msg.includes("🐑 scout delegated"));
  } finally {
    mock.timers.reset();
  }
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
