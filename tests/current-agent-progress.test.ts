import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { makePi, makeCtx } from "./harness.mjs";
import currentAgentProgress from "../extensions/current-agent-progress.ts";

function boot(t: TestContext, mode = "tui") {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10000 });
  const messages: (string | undefined)[] = [];
  const ctx = makeCtx({ spread: { mode } });
  ctx.ui.setWorkingMessage = (message?: string) => messages.push(message);
  const pi = makePi();
  currentAgentProgress(pi);
  const emit = (event: string, data = {}) => pi.emit(event, data, ctx);
  return { emit, messages, last: () => messages.at(-1), tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("times actual model requests, ignores other messages, and stops while idle", async (t) => {
  const { emit, messages, last, tick } = boot(t);
  await emit("agent_start");
  tick(2000);
  assert.deepEqual(messages, []);
  await emit("context");
  assert.equal(last(), "Model working · 0s (escape to interrupt)");
  tick(28000);
  assert.equal(last(), "Model working · 28s (escape to interrupt)");
  await emit("message_end", { message: { role: "user" } });
  await emit("message_end", { message: { role: "toolResult" } });
  tick(1000);
  assert.equal(last(), "Model working · 29s (escape to interrupt)");
  await emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  assert.equal(last(), undefined);
  const calls = messages.length;
  tick(5000);
  assert.equal(messages.length, calls, "no updates during native retry/backoff");
  await emit("context");
  assert.equal(last(), "Model working · 0s (escape to interrupt)");
  await emit("agent_end");
});

test("parallel tools keep their own ages and only expose bounded safe names", async (t) => {
  const { emit, last, tick } = boot(t);
  await emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "SECRET" } });
  tick(2000);
  await emit("tool_execution_start", { toolCallId: "b", toolName: "read", args: { path: "SECRET" } });
  tick(3000);
  await emit("tool_execution_end", { toolCallId: "a" });
  assert.equal(last(), "Running read · 3s (escape to interrupt)");
  await emit("tool_execution_start", { toolCallId: "c", toolName: "write" });
  tick(1000);
  await emit("tool_execution_end", { toolCallId: "c" });
  assert.equal(last(), "Running read · 4s (escape to interrupt)", "ending a sibling never resets the survivor");
  await emit("tool_execution_end", { toolCallId: "b" });
  assert.equal(last(), undefined);
  await emit("tool_execution_start", { toolCallId: "unsafe", toolName: "\x1b\n" + "a".repeat(100), args: { secret: "SECRET" } });
  assert.equal(last(), `Running ${"a".repeat(48)} · 0s (escape to interrupt)`);
  await emit("tool_execution_end", { toolCallId: "unsafe" });
  await emit("tool_execution_start", { toolCallId: "empty", toolName: "\n" });
  assert.equal(last(), "Running tool · 0s (escape to interrupt)");
  await emit("agent_end");
});

test("completion, compaction and session boundaries clear timers and previous tool state", async (t) => {
  const { emit, messages, last, tick } = boot(t);
  for (const event of ["agent_end", "session_before_compact", "session_tree", "session_shutdown", "session_start"]) {
    await emit("context");
    await emit("tool_execution_start", { toolCallId: "old", toolName: "bash" });
    await emit(event);
    assert.equal(last(), undefined, event);
    const calls = messages.length;
    tick(3000);
    assert.equal(messages.length, calls, `${event} leaves no timer`);
    await emit("tool_execution_start", { toolCallId: "new", toolName: "read" });
    assert.equal(last(), "Running read · 0s (escape to interrupt)", `${event} forgets old tools`);
    await emit("tool_execution_end", { toolCallId: "new" });
  }
});

for (const mode of ["rpc", "print"]) {
  test(`${mode} mode does not start timers or change UI`, async (t) => {
    const { emit, messages, tick } = boot(t, mode);
    await emit("context");
    await emit("tool_execution_start", { toolCallId: "a", toolName: "read" });
    tick(5000);
    await emit("tool_execution_end", { toolCallId: "a" });
    await emit("agent_end");
    await emit("session_shutdown");
    assert.deepEqual(messages, []);
  });
}
