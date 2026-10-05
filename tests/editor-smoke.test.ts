// tests/fixtures/editor-smoke.mjs: the deterministic offline provider the parent drives in a
// real TUI via notes/editor-smoke.sh. Pin its verdict mapping (draft-scoped — history must not
// leak scenarios), stream shape, abort behavior, tool call, and evidence logging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePi } from "./harness.mjs";
import editorSmoke from "./fixtures/editor-smoke.mjs";

interface SmokeStream {
  events: { type: string; [k: string]: unknown }[];
  result: () => Promise<{ stopReason: string; errorMessage?: string; content: { type: string; text?: string; name?: string; arguments?: unknown }[] }>;
}
interface SmokeProvider {
  streamSimple: (model: { id: string }, context: { messages: { role: string; content: unknown }[] }, options?: { signal?: AbortSignal }) => SmokeStream;
}

const userMsg = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] });
const EDITOR_SYS = "You are the Editor — an independent reviewer.";
const REVISE_SYS = "You wrote the message in <draft>.";

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "editor-smoke-test-"));
  process.env.EDITOR_SMOKE_EVIDENCE = dir;
  process.env.EDITOR_SMOKE_SLOW_MS = "40";
  process.env.EDITOR_SMOKE_STUBBORN_MS = "60";
  const pi = makePi();
  editorSmoke(pi);
  const provider = pi.providers.smoke as SmokeProvider;
  const stream = (modelId: string, system: string, user: string, signal?: AbortSignal) =>
    provider.streamSimple({ id: modelId }, { messages: [...(system ? [{ role: "system", content: system }] : []), userMsg(user)] }, { signal });
  const call = (modelId: string, system: string, user: string, signal?: AbortSignal) => stream(modelId, system, user, signal).result();
  const textOf = async (p: Promise<{ content: { text?: string }[] }>) => (await p).content.map((b) => b.text ?? "").join("");
  const log = () =>
    readFileSync(join(dir, "requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  return { dir, stream, call, textOf, log, pi };
}

test("smoke provider: verdict mapping keys off the current draft only", async (t) => {
  t.after(() => {
    delete process.env.EDITOR_SMOKE_EVIDENCE;
    delete process.env.EDITOR_SMOKE_SLOW_MS;
    delete process.env.EDITOR_SMOKE_STUBBORN_MS;
  });
  const { call, textOf } = boot();

  assert.equal(await textOf(call("author", "", "approve this please")), "The answer is 4.");
  assert.equal(
    await textOf(call("author", "", "reject this please")),
    "SMOKE_REJECT: Well, to be honest, I think there might be a chance that possibly the answer could be 4, though of course I may be wrong and it depends on many things.",
  );
  assert.equal(await textOf(call("editor", EDITOR_SYS, "<draft>\nThe answer is 4.\n</draft>")), "APPROVE");
  assert.equal(await textOf(call("editor", EDITOR_SYS, "<draft>\nSMOKE_REJECT: …\n</draft>")), "REJECT: too defensive — lead with the answer, drop the hedging");
  assert.equal(await textOf(call("editor", EDITOR_SYS, "<draft>\nSMOKE_MALFORMED: …\n</draft>")), "This looks okay to me, but what do I know.");
  assert.equal(await textOf(call("editor", EDITOR_SYS, "<draft>\nSMOKE_INSUFFICIENT: …\n</draft>")), "INSUFFICIENT");

  // regression: a marker in the quoted conversation (earlier turn) must not steer the verdict —
  // only the current draft counts.
  const contaminated =
    "<conversation>\n[Assistant]: SMOKE_ERROR: delivered unedited earlier\n\n[User]: SMOKE_REJECT talk\n</conversation>\n\n<draft>\nThe answer is 4.\n</draft>";
  assert.equal(await textOf(call("editor", EDITOR_SYS, contaminated)), "APPROVE", "markers outside <draft> are ignored");
});

test("smoke provider: redraft mapping — single, aligned blocks, failure, empty, long", async () => {
  const { call, textOf } = boot();
  assert.equal(await textOf(call("author", REVISE_SYS, "<draft>\nx\n</draft>")), "The answer is 4.");
  // Production prompts carry JSON string literal bodies (lossless quoting); the fixture decodes them.
  assert.equal(await textOf(call("editor", EDITOR_SYS, '<draft>\n"SMOKE_REJECT: …"\n</draft>')), "REJECT: too defensive — lead with the answer, drop the hedging");
  assert.equal(await textOf(call("author", REVISE_SYS, '<draft>\n<block-1>\n"SMOKE_MULTIBLOCK a"\n</block-1>\n<block-2>\n"b"\n</block-2>\n</draft>')), '["The answer is 4.","Supporting detail, kept."]');
  const fail = await call("author", REVISE_SYS, "<draft>\nSMOKE_REVFAIL: x\n</draft>");
  assert.equal(fail.stopReason, "error");
  assert.equal(fail.errorMessage, "smoke redraft failure");
  assert.equal(await textOf(call("author", REVISE_SYS, "<draft>\nSMOKE_REVEMPTY: x\n</draft>")), "");
  const long = await textOf(call("author", REVISE_SYS, "<draft>\nSMOKE_REVLONG: x\n</draft>"));
  assert.ok(long.length > 500, `long redraft: ${long.length} chars`);
  // noop: draft carries a trailing newline; the redraft returns every word, minus that newline —
  // the field-observed masquerade shape the editor must treat as a delivery no-op.
  const noopDraft = "SMOKE_NOOP: The answer is 4.\n";
  assert.equal(await textOf(call("author", "", "noop please")), noopDraft);
  assert.equal(await textOf(call("editor", EDITOR_SYS, `<draft>\n${JSON.stringify(noopDraft)}\n</draft>`)), "REJECT: could be tighter");
  assert.equal(await textOf(call("author", REVISE_SYS, `<draft>\n${JSON.stringify(noopDraft)}\n</draft>`)), "SMOKE_NOOP: The answer is 4.");
  // decorated: benign markdown wrapper on a one-word verdict; contradict: two verdicts in one
  // decorated line (the parser must fail open on it — the fixture emits the raw shape verbatim).
  assert.equal(await textOf(call("editor", EDITOR_SYS, "<draft>\nSMOKE_DECORATED: …\n</draft>")), "**APPROVE**");
  assert.equal(await textOf(call("editor", EDITOR_SYS, "<draft>\nSMOKE_CONTRADICT: …\n</draft>")), "**REJECT: tighten.** **APPROVE**");
});

test("smoke provider: real stream shape start/text_start/text_delta/text_end/done, abort mid-stream", async () => {
  const { stream } = boot();
  const s = stream("author", "", "approve this please");
  await s.result();
  const types = s.events.map((e) => e.type);
  assert.deepEqual([...new Set(types)], ["start", "text_start", "text_delta", "text_end", "done"]);
  assert.ok(types.indexOf("start") < types.indexOf("text_start"), "start first");
  assert.ok(types.lastIndexOf("text_end")! < types.indexOf("done"), "done last");

  const ctl = new AbortController();
  const slow = stream("author", "", "reject this please", ctl.signal);
  ctl.abort();
  const aborted = await slow.result();
  assert.equal(aborted.stopReason, "aborted", "abort mid-stream ends the stream");
});

test("smoke provider: hang honors abort; stubborn ignores it and answers late; slow verdict delayed", async () => {
  const { call, log, textOf } = boot();

  const ctl = new AbortController();
  const hung = call("editor", EDITOR_SYS, "<draft>\nSMOKE_HANG: …\n</draft>", ctl.signal);
  const winner = await Promise.race([hung.then(() => "resolved"), new Promise((r) => setTimeout(() => r("pending"), 100))]);
  assert.equal(winner, "pending", "hangs until aborted");
  ctl.abort();
  assert.equal((await hung).stopReason, "aborted");

  const ctl2 = new AbortController();
  const stubborn = call("editor", EDITOR_SYS, "<draft>\nSMOKE_STUBBORN: …\n</draft>", ctl2.signal);
  ctl2.abort();
  const early = await Promise.race([stubborn.then(() => "resolved"), new Promise((r) => setTimeout(() => r("pending"), 30))]);
  assert.equal(early, "pending", "stubborn ignores the abort");
  assert.equal(await textOf(stubborn), "REJECT: late verdict, must be ignored", "answers late anyway");
  assert.ok(log().some((l) => l.event === "abort" && l.ignored === true), "late answer logged as abort-ignoring");

  const t0 = Date.now();
  assert.equal(await textOf(call("editor", EDITOR_SYS, "<draft>\nSMOKE_SLOW: …\n</draft>")), "APPROVE");
  assert.ok(Date.now() - t0 >= 30, "slow verdict actually waits");

  const ctl3 = new AbortController();
  const slowAbort = call("editor", EDITOR_SYS, "<draft>\nSMOKE_SLOW: …\n</draft>", ctl3.signal);
  ctl3.abort();
  assert.equal((await slowAbort).stopReason, "aborted", "slow verdict honors abort");
});

test("smoke provider: toolcall streams a smoke_echo call (toolUse), toolResult turn answers final text; multiblock keeps both blocks", async () => {
  const { call, pi } = boot();
  const tc = await call("author", "", "toolcall please");
  assert.equal(tc.stopReason, "toolUse");
  const toolCall = tc.content.find((b) => b.type === "toolCall");
  assert.equal(toolCall?.name, "smoke_echo");
  assert.deepEqual(toolCall?.arguments, { text: "ping" });
  assert.equal(tc.content.find((b) => b.type === "text")?.text, "Let me check that with the echo tool.");

  const tool = pi.tools.smoke_echo;
  const tr = await tool.execute("id", { text: "ping" }, undefined, undefined, undefined);
  assert.equal(tr.content[0].text, "echo: ping");

  const toolResultMsg = { role: "toolResult", content: [{ type: "text", text: "echo: ping" }] };
  const s2 = (pi.providers.smoke as SmokeProvider).streamSimple({ id: "author" }, { messages: [userMsg("toolcall please"), toolResultMsg] });
  const final = await s2.result();
  assert.equal(final.stopReason, "stop");
  assert.deepEqual(final.content.map((b) => b.text), ["The answer is 4."], "toolResult turn answers final text, no second tool call");

  const mb = await call("author", "", "multiblock please");
  assert.deepEqual(mb.content.map((b) => b.text), ["SMOKE_MULTIBLOCK: Well, to be honest, part one might possibly be this.", "Part two adds a second detail."]);
  const ok = await call("author", "", "multiok please");
  assert.deepEqual(ok.content.map((b) => b.text), ["The answer is 4.", "Computed with `node -e 'console.log(2 + 2)'`."]);
});

test("smoke provider: toolResult detection is scoped to the turn after the latest user message", async () => {
  const { call, pi } = boot();
  // After a completed toolcall turn, a NEW scenario prompt must still map its scenario:
  // the stale toolResult from the earlier turn must not force the clean post-tool answer.
  const provider = pi.providers.smoke as SmokeProvider;
  const history = [
    userMsg("toolcall please"),
    { role: "toolResult", content: [{ type: "text", text: "echo: ping" }] },
    userMsg("reject this please"),
  ];
  const later = await provider.streamSimple({ id: "author" }, { messages: history }).result();
  assert.match(later.content.map((b) => b.text).join(""), /SMOKE_REJECT/, "scenario mapping survives an older toolResult");

  // control: a toolResult since the latest user message is the post-tool turn → clean final text
  const cont = await provider.streamSimple({ id: "author" }, { messages: [userMsg("toolcall please"), history[1]] }).result();
  assert.deepEqual(cont.content.map((b) => b.text), ["The answer is 4."]);
});

test("smoke provider: stubborn redraft ignores abort and answers late; toolcall-stubborn pairs a call with a hanging editorial", async () => {
  const { call, textOf, log } = boot();
  // revstubborn: the EDITOR verdict is normal REJECT; the AUTHOR redraft ignores abort and lands late.
  assert.equal(
    await textOf(call("editor", EDITOR_SYS, "<draft>\nSMOKE_REVSTUBBORN: …\n</draft>")),
    "REJECT: too defensive — lead with the answer, drop the hedging",
  );
  const ctl = new AbortController();
  const late = call("author", REVISE_SYS, "<draft>\nSMOKE_REVSTUBBORN: …\n</draft>", ctl.signal);
  ctl.abort();
  const early = await Promise.race([late.then(() => "resolved"), new Promise((r) => setTimeout(() => r("pending"), 30))]);
  assert.equal(early, "pending", "stubborn redraft ignores the abort");
  assert.match(await textOf(late), /late redraft, must be ignored/);
  assert.ok(log().some((l) => l.event === "abort" && l.ignored === true), "late redraft logged as abort-ignoring");

  // user-scenario mapping: "revstubborn" must not fall into the "stubborn" prefix branch
  const rev = await call("author", "", "revstubborn please");
  assert.match(rev.content.map((b) => b.text).join(""), /SMOKE_REVSTUBBORN/);

  // toolcall-stubborn: commentary carries the stubborn marker so the editorial verdict on the
  // commentary hangs; the source tool call rides along in the same message.
  const tc = await call("author", "", "toolcall-stubborn please");
  assert.equal(tc.stopReason, "toolUse");
  assert.match(tc.content.find((b) => b.type === "text")?.text ?? "", /SMOKE_STUBBORN/);
  assert.equal(tc.content.find((b) => b.type === "toolCall")?.name, "smoke_echo");
  // …and the editorial verdict on that commentary is the stubborn hang:
  const ctl2 = new AbortController();
  const verdict = call("editor", EDITOR_SYS, "<draft>\nSMOKE_STUBBORN: Let me check that with the echo tool.\n</draft>", ctl2.signal);
  ctl2.abort();
  assert.match(await textOf(verdict), /REJECT: late verdict, must be ignored/);
});

test("smoke provider: error scenario and request log shape (durations + editor context)", async () => {
  const { call, log } = boot();
  const err = await call("editor", EDITOR_SYS, "<draft>\nSMOKE_ERROR: …\n</draft>");
  assert.equal(err.stopReason, "error");
  assert.equal(err.errorMessage, "smoke editor failure");

  const lines = log();
  const editorReq = lines.find((l) => l.event === "request" && l.model === "editor");
  assert.deepEqual(editorReq.roles, ["system", "user"], "editor context: system + one user message, no tools");
  const editorDone = lines.find((l) => l.event === "complete" && l.req === editorReq.req);
  assert.equal(editorDone.stopReason, "error");
  assert.equal(typeof editorDone.durationMs, "number", "timings recorded for readback");
  assert.ok(lines.filter((l) => l.event === "request").length >= 1);
});
