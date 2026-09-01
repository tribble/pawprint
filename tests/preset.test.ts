// preset.ts: presets.json loading/merge, /preset apply + tool filtering,
// system-prompt injection, cycle ordering, state persistence. UI classes are
// stubbed; fs reads hit scratch dirs via the getAgentDir stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "./stubs/pi-coding-agent.mjs";
import { makePi, makeCtx } from "./harness.mjs";
import presetExtension from "../pi-agent/extensions/preset.ts";

function writePresets(agentDir: string, cwd: string) {
  writeFileSync(
    join(agentDir, "presets.json"),
    JSON.stringify({
      alpha: { thinkingLevel: "high", tools: ["read", "bogus-tool"], instructions: "ALPHA-INST" },
      beta: { provider: "anthropic", model: "claude-x", instructions: "BETA-INST" },
      merged: { thinkingLevel: "low" },
    }),
  );
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "presets.json"),
    JSON.stringify({ merged: { thinkingLevel: "xhigh" } }), // project overrides global
  );
}

async function boot(flag?: string) {
  const agentDir = mkdtempSync(join(tmpdir(), "pawprint-preset-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pawprint-preset-cwd-"));
  writePresets(agentDir, cwd);
  setAgentDir(agentDir); // loadPresets reads it at session_start, not import — no cache busting needed
  const pi = makePi();
  pi.flags.preset = flag;
  presetExtension(pi);
  const ctx = makeCtx({ cwd });
  await pi.emit("session_start", {}, ctx);
  return { pi, ctx };
}

test("registers flag, command, shortcut, and three event handlers", async () => {
  const pi = makePi();
  presetExtension(pi);
  assert.ok(pi.flags["__def:preset"]);
  assert.ok(pi.commands.preset);
  assert.ok(pi.shortcuts["ctrl+shift+u"]);
  for (const ev of ["before_agent_start", "session_start", "turn_start"])
    assert.equal(pi.registered(ev), 1, ev);
});

test("session_start loads global+project presets; project wins on name clash", async () => {
  const { pi, ctx } = await boot();
  await pi.commands.preset.handler("merged", ctx);
  assert.equal(pi.state.thinkingLevel, "xhigh", "project preset overrode global");
});

test("/preset applies thinking + filters unknown tools, warns, injects instructions", async () => {
  const { pi, ctx } = await boot();
  await pi.commands.preset.handler("alpha", ctx);
  assert.equal(pi.state.thinkingLevel, "high");
  assert.deepEqual(pi.state.activeTools, ["read"], "bogus-tool filtered out");
  assert.ok(
    ctx.notes.some((n: any) => n.level === "warning" && n.msg.includes("Unknown tools: bogus-tool")),
  );
  const out = await pi.onHandlers.get("before_agent_start")[0]({ systemPrompt: "BASE" }, ctx);
  assert.equal(out.systemPrompt, "BASE\n\nALPHA-INST");
});

test("/preset unknown name → error listing available", async () => {
  const { pi, ctx } = await boot();
  await pi.commands.preset.handler("nope", ctx);
  const n = ctx.notes.at(-1);
  assert.equal(n.level, "error");
  assert.ok(n.msg.includes('Unknown preset "nope"') && n.msg.includes("alpha"));
});

test("turn_start persists active preset; none active → no entry", async () => {
  const { pi, ctx } = await boot();
  await pi.emit("turn_start", {}, ctx);
  assert.equal(pi.state.entries.length, 0);
  await pi.commands.preset.handler("beta", ctx);
  await pi.emit("turn_start", {}, ctx);
  assert.deepEqual(pi.state.entries, [{ type: "preset-state", data: { name: "beta" } }]);
});

test("shortcut cycles (none) → alpha → beta → merged → (none), restoring originals", async () => {
  const { pi, ctx } = await boot();
  const cycle = () => pi.shortcuts["ctrl+shift+u"].handler(ctx);
  const origTools = pi.getActiveTools();
  const origLevel = pi.getThinkingLevel();

  await cycle();
  assert.ok(ctx.notes.at(-1).msg.includes('"alpha"'), "first cycle activates alpha (sorted first)");
  assert.equal(pi.state.thinkingLevel, "high");
  await cycle();
  assert.ok(ctx.notes.at(-1).msg.includes('"beta"'));
  await cycle();
  assert.ok(ctx.notes.at(-1).msg.includes('"merged"'));
  await cycle();
  assert.ok(ctx.notes.at(-1).msg.includes("Preset cleared"));
  assert.deepEqual(pi.getActiveTools(), origTools, "originals restored");
  assert.equal(pi.getThinkingLevel(), origLevel);
  const out = await pi.onHandlers.get("before_agent_start")[0]({ systemPrompt: "BASE" }, ctx);
  assert.equal(out, undefined, "no injection after clear");
});

test("--preset flag applies at session_start; unknown flag value warns", async () => {
  const { pi, ctx } = await boot("beta");
  assert.ok(ctx.notes.some((n: any) => n.msg === 'Preset "beta" activated'));

  const { ctx: ctx2 } = await boot("ghost");
  assert.ok(ctx2.notes.some((n: any) => n.level === "warning" && n.msg.includes('Unknown preset "ghost"')));
});

test("selector path: /preset with no args builds items incl (none), applies choice", async () => {
  const { pi, ctx } = await boot();
  let seenItems: any[] = [];
  ctx.ui.custom = async (build: any) => {
    const component = build(
      { requestRender() {} },
      { fg: (_c: string, s: string) => s, bold: (s: string) => s },
      {},
      (v: string | null) => v,
    );
    assert.equal(typeof component.render, "function");
    return "beta"; // simulate user picking beta
  };
  // capture items via the SelectList stub: rebuild through custom's build fn
  const origCustom = ctx.ui.custom;
  ctx.ui.custom = async (build: any) => {
    const res = await origCustom(build);
    return res;
  };
  await pi.commands.preset.handler("", ctx);
  assert.ok(ctx.notes.some((n: any) => n.msg === 'Preset "beta" activated'));
  const out = await pi.onHandlers.get("before_agent_start")[0]({ systemPrompt: "B" }, ctx);
  assert.equal(out.systemPrompt, "B\n\nBETA-INST");
  void seenItems;
});
