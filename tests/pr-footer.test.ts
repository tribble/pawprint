// pr-footer.ts: footer status "prs" mirrors pr-watch's cached needs_review
// count (non-draft); zero, a missing file or malformed JSON clears it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makePi, makeCtx } from "./harness.mjs";

const stateDir = mkdtempSync(join(tmpdir(), "pr-footer-"));
process.env.PR_WATCH_STATE_DIR = stateDir;
const stateFile = join(stateDir, "state.json");
const { default: prFooter } = await import("../pi-agent/extensions/pr-footer.ts");

const pr = (isDraft = false) => ({ repo: "o/r", number: 1, title: "t", isDraft });
const state = (needs_review: unknown) => JSON.stringify({ fetched_at: 0, needs_review, mine: [], involves: [] });

function writeState(content: string | undefined) {
  if (content === undefined) rmSync(stateFile, { force: true });
  else writeFileSync(stateFile, content);
}

// Pre-seeds a stale status so "cleared" means actively cleared, not never set.
async function start(content: string | undefined, hasUI = true) {
  writeState(content);
  const pi = makePi();
  const ctx = makeCtx();
  ctx.hasUI = hasUI;
  ctx.statuses.set("prs", "stale");
  prFooter(pi);
  await pi.emit("session_start", { reason: "startup" }, ctx);
  return { pi, ctx, status: () => ctx.statuses.get("prs") };
}

test("non-draft review requests → count shown; drafts excluded", async () => {
  const { pi, ctx, status } = await start(state([pr(), pr(), pr(true)]));
  assert.equal(status(), "⚑ 2 need review");
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("one request → singular", async () => {
  const { pi, ctx, status } = await start(state([pr()]));
  assert.equal(status(), "⚑ 1 needs review");
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("zero → cleared", async () => {
  const { pi, ctx, status } = await start(state([]));
  assert.equal(status(), undefined);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("missing file → cleared, no notify", async () => {
  const { pi, ctx, status } = await start(undefined);
  assert.equal(status(), undefined);
  assert.deepEqual(ctx.notes, []);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("malformed JSON → cleared, no notify", async () => {
  const { pi, ctx, status } = await start("{not json");
  assert.equal(status(), undefined);
  assert.deepEqual(ctx.notes, []);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("no UI → status untouched", async () => {
  const { status } = await start(state([pr()]), false);
  assert.equal(status(), "stale");
});

// The extension calls the timer globals at run time, so spying on them lets a
// test grab the interval callback (and await one tick to completion — no fake
// clock, no sleeps) and see cancellation by handle instead of inferring it.
function spyTimers() {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const set: { fn: () => Promise<void>; ms: number; handle: unknown }[] = [];
  const cleared: unknown[] = [];
  globalThis.setInterval = ((fn: () => Promise<void>, ms: number) => {
    const handle = realSet(fn, ms);
    set.push({ fn, ms, handle });
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    cleared.push(handle);
    realClear(handle as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;
  return {
    set,
    cleared,
    restore() {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      for (const s of set) realClear(s.handle as ReturnType<typeof setInterval>);
    },
  };
}

// Records setStatus calls made after `dead` is flipped — in pi those would hit
// an invalidated context and throw.
function guardCtx(ctx: any) {
  const real = ctx.ui.setStatus.bind(ctx.ui);
  const g = { dead: false, callsAfterShutdown: 0 };
  ctx.ui.setStatus = (k: string, v: string | undefined) => {
    if (g.dead) g.callsAfterShutdown += 1;
    else real(k, v);
  };
  return g;
}

test("re-reads every 5 minutes; shutdown clears the interval", async () => {
  const timers = spyTimers();
  try {
    const { pi, ctx, status } = await start(state([pr()]));
    assert.equal(timers.set.length, 1);
    const { fn, ms, handle } = timers.set[0];
    assert.equal(ms, 5 * 60_000);
    writeState(state([pr(), pr(), pr()]));
    await fn(); // one interval tick, run to completion
    assert.equal(status(), "⚑ 3 need review");
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    assert.ok(timers.cleared.includes(handle), "interval handle cleared on shutdown");
  } finally {
    timers.restore();
  }
});

test("refresh in flight at shutdown never touches the (now invalid) context", async () => {
  const timers = spyTimers();
  try {
    const { pi, ctx } = await start(state([pr()]));
    const g = guardCtx(ctx);
    const inFlight = timers.set[0].fn(); // the read is pending...
    await pi.emit("session_shutdown", { reason: "reload" }, ctx); // ...when pi tears the ctx down
    g.dead = true;
    await inFlight;
    assert.equal(g.callsAfterShutdown, 0);
  } finally {
    timers.restore();
  }
});

test("shutdown during the initial refresh: no ctx access, no interval scheduled", async () => {
  const timers = spyTimers();
  try {
    writeState(state([pr()]));
    const pi = makePi();
    const ctx = makeCtx();
    const g = guardCtx(ctx);
    prFooter(pi);
    const starting = pi.emit("session_start", { reason: "startup" }, ctx); // first read pending...
    await pi.emit("session_shutdown", { reason: "reload" }, ctx);
    g.dead = true;
    await starting;
    assert.equal(g.callsAfterShutdown, 0);
    assert.equal(timers.set.length, 0, "no interval scheduled after shutdown");
  } finally {
    timers.restore();
  }
});
