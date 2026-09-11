// pr-footer.ts: footer status "prs" mirrors pr-watch's cached needs_review
// count (non-draft); zero, a missing file or malformed JSON clears it.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makePi, makeCtx, eventually } from "./harness.mjs";

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

test("re-reads every 5 minutes; shutdown stops the timer", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { pi, ctx, status } = await start(state([pr()]));
    writeState(state([pr(), pr(), pr()]));
    mock.timers.tick(5 * 60_000);
    assert.ok(await eventually(() => status() === "⚑ 3 need review"), `got ${status()}`);
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    writeState(state([]));
    mock.timers.tick(5 * 60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(status(), "⚑ 3 need review", "no refresh after shutdown");
  } finally {
    mock.timers.reset();
  }
});
