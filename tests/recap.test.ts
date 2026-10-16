import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { makePi, makeCtx, eventually } from "./harness.mjs";

const text = "**Where we left off:** Built the fixture.\n\n**What's next:** Verify it.\n\n**What I need from you:** Nothing.";
const ok = { stopReason: "stop", content: [{ type: "text", text }] };
const projection = [{ role: "system", content: "Original prompt", toolsAdded: [{ name: "read", parameters: {} }], timestamp: 1 }, { role: "user", content: "Stored conversation", timestamp: 2 }];

async function boot(result: (options: SimpleStreamOptions) => Promise<unknown> = async () => ok) {
  const { default: recap } = await import("../extensions/recap.ts");
  const pi = makePi();
  const ctx = makeCtx({ sessionId: "original-cache-id", leafId: "leaf" });
  const calls: { model: unknown; context: Context; options: SimpleStreamOptions }[] = [];
  ctx.sessionManager.buildSessionProjection = () => ({ messages: projection });
  ctx.modelRegistry.streamSimple = (model: unknown, context: Context, options: SimpleStreamOptions) => {
    calls.push({ model, context, options });
    return { result: () => result(options) };
  };
  for (const name of ["sendUserMessage", "sendMessage", "setModel"]) pi[name] = () => assert.fail(`Main agent action: ${name}`);
  ctx.abort = () => assert.fail("Main agent must not be aborted");
  recap(pi);
  return { pi, ctx, calls, run: (args = "") => pi.commands.recap.handler(args, ctx) };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
}

test("native /recap command persists only a custom entry, respects compaction/context edits, and restores its renderer", () => {
  const output = execFileSync(process.execPath, ["tests/recap-native.mjs"], { encoding: "utf8", timeout: 30_000 });
  assert.match(output, /"status":"passed"/);
});

test("detached request preserves stored prefix and cache identity; renderer displays the answer", async () => {
  const before = structuredClone(projection);
  const { pi, ctx, calls, run } = await boot();
  await run();
  assert.equal(await eventually(() => ctx.statuses.size === 0), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, ctx.model);
  assert.equal(calls[0]!.options.sessionId, "original-cache-id");
  const messages = calls[0]!.context.messages;
  assert.deepEqual(messages.slice(0, -1), projection);
  const prompt = JSON.stringify(messages.at(-1));
  for (const heading of ["Where we left off:", "What's next:", "What I need from you:"]) assert.ok(prompt.includes(heading));
  assert.ok(prompt.includes("don't run tools"));
  const head = messages[0]!;
  if (head.role === "system") head.content = "Provider-local mutation";
  assert.deepEqual(projection, before);
  assert.equal(pi.userMessages.length, 0);
  assert.equal(pi.execCalls.length, 0);
  assert.equal(pi.state.entries.length, 1);
  assert.equal(pi.state.entries[0].type, "recap");
  const data = pi.state.entries[0].data;
  assert.equal(data.text, text);
  const view = pi.entryRenderers.recap({ data }, { expanded: false }, ctx.ui.theme);
  assert.match(view.children[0].text, /recap.*anthropic\/claude-test/);
  assert.equal(view.children[1].text, text);
  assert.equal(ctx.statuses.size, 0);
  assert.deepEqual(ctx.notes, []);
});

test("working agent, no model and unknown arguments give actionable errors without a request", async () => {
  const busy = await boot();
  busy.ctx.isIdle = () => false;
  await busy.run();
  assert.equal(busy.calls.length, 0);
  assert.match(busy.ctx.notes.at(-1).msg, /working.*retry|finish/i);
  const noModel = await boot();
  noModel.ctx.model = undefined;
  await noModel.run();
  assert.equal(noModel.calls.length, 0);
  assert.match(noModel.ctx.notes.at(-1).msg, /model/i);
  const args = await boot();
  await args.run("extra");
  assert.equal(args.calls.length, 0);
  assert.match(args.ctx.notes.at(-1).msg, /usage/i);
});

test("overlap is refused; /recap cancel aborts only its request and releases status", async () => {
  const pending = deferred();
  const { pi, ctx, calls, run } = await boot((options) => {
    options.signal!.addEventListener("abort", () => pending.resolve({ stopReason: "aborted", content: [] }), { once: true });
    return pending.promise;
  });
  let received = false;
  const receipt = run().then(() => { received = true; });
  assert.equal(await eventually(() => received, 100), true, "command receipt must not wait for provider completion");
  await receipt;
  assert.equal(ctx.statuses.size, 1);
  await run();
  assert.equal(calls.length, 1);
  assert.match(ctx.notes.at(-1).msg, /already|running/);
  await run("cancel");
  assert.equal(await eventually(() => ctx.statuses.size === 0), true);
  assert.equal(calls[0]!.options.signal!.aborted, true);
  assert.equal(pi.state.entries.length, 0);
  assert.equal(ctx.statuses.size, 0);
  assert.match(ctx.notes.at(-1).msg, /cancelled/i);
  ctx.modelRegistry.streamSimple = () => ({ result: async () => ok });
  await run();
  assert.equal(await eventually(() => ctx.statuses.size === 0), true);
  assert.equal(pi.state.entries.length, 1);
});

for (const event of ["session_tree", "session_shutdown"]) {
  test(`${event} cancels pending recap and prevents late publication`, async () => {
    const pending = deferred();
    const { pi, ctx, calls, run } = await boot(() => pending.promise);
    await run();
    await pi.emit(event, {}, ctx);
    assert.equal(calls[0]!.options.signal!.aborted, true);
    pending.resolve(ok);
    assert.equal(await eventually(() => ctx.statuses.size === 0), true);
    assert.equal(pi.state.entries.length, 0);
    assert.equal(ctx.statuses.size, 0);
  });
}

for (const change of ["branch", "session", "model", "working"]) {
  test(`changed ${change} drops the result without modifying the new context`, async () => {
    const pending = deferred();
    const { pi, ctx, run } = await boot(() => pending.promise);
    await run();
    if (change === "branch") ctx.sessionManager.getLeafId = () => "different";
    if (change === "session") ctx.sessionManager.getSessionId = () => "different";
    if (change === "model") ctx.model = { provider: "other", id: "other" };
    if (change === "working") ctx.isIdle = () => false;
    pending.resolve(ok);
    assert.equal(await eventually(() => ctx.statuses.size === 0), true);
    assert.equal(pi.state.entries.length, 0);
    assert.match(ctx.notes.at(-1).msg, /changed|discarded|dropped/);
    assert.equal(ctx.statuses.size, 0);
  });
}

for (const [name, response, expected] of [
  ["provider error", { stopReason: "error", errorMessage: "provider unavailable", content: [] }, /provider unavailable/],
  ["provider cancellation", { stopReason: "aborted", content: [] }, /cancelled/],
  ["empty response", { stopReason: "stop", content: [{ type: "text", text: "  " }] }, /empty/],
  ["tool call", { stopReason: "toolUse", content: [{ type: "toolCall", name: "read", id: "call", arguments: {} }] }, /tool|finish/],
  ["truncation", { stopReason: "length", content: [{ type: "text", text: "unfinished" }] }, /2048-token output limit/],
] as const) {
  test(`${name} is reported without an entry; status and overlap guard recover`, async () => {
    const { pi, ctx, calls, run } = await boot(async () => response);
    await run();
    assert.equal(await eventually(() => ctx.statuses.size === 0), true);
    assert.equal(calls.length, 1);
    assert.equal(pi.state.entries.length, 0);
    assert.equal(pi.execCalls.length, 0);
    assert.match(ctx.notes.at(-1).msg, expected);
    assert.equal(ctx.statuses.size, 0);
    ctx.modelRegistry.streamSimple = () => ({ result: async () => ok });
    await run();
    assert.equal(await eventually(() => ctx.statuses.size === 0), true);
    assert.equal(pi.state.entries.length, 1);
  });
}

test("thrown dispatch and snapshot errors release status and allow retry", async () => {
  const { pi, ctx, run } = await boot();
  ctx.modelRegistry.streamSimple = () => { throw new Error("setup failed"); };
  await run();
  assert.equal(await eventually(() => ctx.statuses.size === 0), true);
  assert.match(ctx.notes.at(-1).msg, /setup failed/);
  ctx.sessionManager.buildSessionProjection = () => { throw new Error("snapshot failed"); };
  await run();
  assert.equal(await eventually(() => ctx.statuses.size === 0), true);
  assert.match(ctx.notes.at(-1).msg, /snapshot failed/);
  assert.equal(pi.state.entries.length, 0);
  assert.equal(ctx.statuses.size, 0);
});
