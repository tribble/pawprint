// compaction-fallback.ts: on compaction failure, hop to a cross-family scoped
// model, retry once, restore. Restore-in-abort case (e) is the regression
// test for the restoreBeforeAbort fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePi, makeCtx } from "./harness.mjs";
import compactionFallback from "../pi-agent/extensions/compaction-fallback.ts";

const CURRENT = { provider: "anthropic", id: "claude-x" };
const ev = (extra: object = {}) => ({ aborted: false, errorMessage: "refused", reason: "threshold", ...extra });

function setup(opts: { scoped?: string[]; setModelOk?: boolean } = {}) {
  const pi = makePi();
  const modelCalls: any[] = [];
  const origSetModel = pi.setModel.bind(pi);
  pi.setModel = async (m: any) => {
    modelCalls.push(m);
    if (opts.setModelOk === false) return false;
    return origSetModel(m);
  };
  const ctx = makeCtx();
  ctx.model = CURRENT;
  ctx.scopedModels = (opts.scoped ?? ["kimi-k3"]).map((id) => ({ model: { provider: "x", id } }));
  let compacts = 0;
  ctx.compact = async () => {
    compacts += 1;
  };
  compactionFallback(pi);
  return { pi, ctx, modelCalls, compacts: () => compacts };
}

test("(a) first failure + fallback exists → setModel(fallback), compact retried, warning names it", async () => {
  const { pi, ctx, modelCalls, compacts } = setup();
  await pi.emit("session_compact_failed", ev(), ctx);
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].id, "kimi-k3");
  assert.equal(compacts(), 1, "compaction retried on fallback");
  const warn = ctx.notes.find((n: any) => n.level === "warning");
  assert.ok(warn?.msg.includes("kimi-k3"), "warning mentions the fallback id");
});

test("(b) session_compact after fallback → original model restored", async () => {
  const { pi, ctx, modelCalls } = setup();
  await pi.emit("session_compact_failed", ev(), ctx);
  await pi.emit("session_compact", {}, ctx);
  assert.equal(modelCalls.at(-1), CURRENT, "restored to the original model object");
});

test("(c) compact_failed again mid-fallback → restore + fail through, no second compact", async () => {
  const { pi, ctx, modelCalls, compacts } = setup();
  await pi.emit("session_compact_failed", ev(), ctx);
  await pi.emit("session_compact_failed", ev(), ctx);
  assert.equal(compacts(), 1, "no second retry");
  assert.deepEqual(
    modelCalls.map((m) => m.id),
    ["kimi-k3", "claude-x"],
    "fallback then restore",
  );
});

test("(d) aborted FIRST failure → no-op", async () => {
  const { pi, ctx, modelCalls, compacts } = setup();
  await pi.emit("session_compact_failed", ev({ aborted: true }), ctx);
  assert.equal(modelCalls.length, 0, "no setModel on abort");
  assert.equal(compacts(), 0);
});

test("(e) regression: abort while fallback in flight → original restored", async () => {
  const { pi, ctx, modelCalls } = setup();
  await pi.emit("session_compact_failed", ev(), ctx); // fallback in flight
  await pi.emit("session_compact_failed", ev({ aborted: true }), ctx); // user aborts the retry
  assert.deepEqual(
    modelCalls.map((m) => m.id),
    ["kimi-k3", "claude-x"],
    "abort no longer strands the session on the fallback",
  );
});

test("(f) no scoped candidates → no-op", async () => {
  const { pi, ctx, modelCalls, compacts } = setup({ scoped: [] });
  // current model is also excluded from candidates even if scoped
  ctx.scopedModels = [{ model: CURRENT }];
  await pi.emit("session_compact_failed", ev(), ctx);
  assert.equal(modelCalls.length, 0);
  assert.equal(compacts(), 0);
});

test("(g) setModel refuses (no API key) → no compact, no fallback state left behind", async () => {
  const { pi, ctx, modelCalls, compacts } = setup({ setModelOk: false });
  await pi.emit("session_compact_failed", ev(), ctx);
  assert.equal(modelCalls.length, 1, "tried the fallback");
  assert.equal(compacts(), 0, "but never retried compaction");
  // restoreAfter unset: a later session_compact must NOT touch the model
  await pi.emit("session_compact", {}, ctx);
  assert.equal(modelCalls.length, 1);
});

test("(h) PREFER order: gpt-5.6-sol beats kimi when both are scoped", async () => {
  const { pi, ctx, modelCalls } = setup({ scoped: ["kimi-k3", "gpt-5.6-sol-x"] });
  await pi.emit("session_compact_failed", ev(), ctx);
  assert.equal(modelCalls[0].id, "gpt-5.6-sol-x");
});
