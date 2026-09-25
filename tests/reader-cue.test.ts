// reader-cue.ts: context_with_system hook appends CUE to every user-role message (string or
// last text block), leaves other roles — system messages included, in place — alone, never
// mutates the originals; /reader-cue off|on toggles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makePi, makeCtx } from "./harness.mjs";
import readerCue, { CUE } from "../extensions/reader-cue.ts";

const user = (content: unknown) => ({ role: "user", content, timestamp: 1 });
const text = (t: string) => ({ type: "text", text: t });

// Transcript messages as the hook sees them: role + content plus arbitrary per-role extras.
type CueMsg = { role: string; content: unknown; [key: string]: unknown };

function boot() {
  const pi = makePi();
  readerCue(pi);
  const ctx = makeCtx();
  const run = async (messages: CueMsg[]) => {
    let out: { messages: CueMsg[] } | undefined;
    for (const h of pi.onHandlers.get("context_with_system") ?? []) out = await h({ type: "context_with_system", messages }, ctx);
    return out!.messages;
  };
  return { pi, ctx, run };
}

test("CUE is byte-identical to the measured text", () => {
  const measured = `${process.env.HOME}/.pi/agent/tmp/density-exp/cue.md`;
  let expected: string;
  try { expected = readFileSync(measured, "utf8").trim(); } catch { return; } // file is machine-local; skip elsewhere
  assert.equal(CUE, expected);
});

test("every user message gets the cue; system/assistant/toolResult/custom untouched and in place; originals not mutated", async () => {
  const { run } = boot();
  const head = { role: "system", content: "BASE", toolsAdded: [] };
  const delta = { role: "system", content: "", sections: { skills: "LATER" } }; // mid-transcript prompt delta must not move
  const first = user("first question");
  const blocks = user([{ type: "image", data: "x" }, text("look"), text("at this")]);
  const imageOnly = user([{ type: "image", data: "x" }]);
  const others = [
    { role: "assistant", content: [text("answer")] },
    { role: "toolResult", content: [text("tool out")] },
    { role: "custom", customType: "intercom", content: "steer" },
  ];
  const input: CueMsg[] = [head, first, others[0], blocks, delta, others[1], imageOnly, others[2]];
  const out = await run(input);
  assert.deepEqual(out.map((m) => m.role), input.map((m) => m.role), "roles and positions unchanged");
  assert.ok(out[0] === head && out[4] === delta, "system messages are the same objects, in place");
  out.splice(4, 1); out.shift(); // drop the system messages: indices below are for the remaining six

  assert.equal(out[0].content, `first question\n\n${CUE}`);
  assert.deepEqual(out[2].content, [{ type: "image", data: "x" }, text("look"), text(`at this\n\n${CUE}`)]);
  assert.deepEqual(out[4].content, [{ type: "image", data: "x" }, text(CUE)]);
  assert.equal(out[1], others[0]);
  assert.equal(out[3], others[1]);
  assert.equal(out[5], others[2]);
  assert.equal(out[0].timestamp, 1);

  assert.equal(first.content, "first question");
  assert.deepEqual(blocks.content, [{ type: "image", data: "x" }, text("look"), text("at this")]);
  assert.deepEqual(input, [head, first, others[0], blocks, delta, others[1], imageOnly, others[2]]);
});

test("/reader-cue off passes messages through; on re-enables; bad arg → usage", async () => {
  const { pi, ctx, run } = boot();
  const msgs = [user("q")];
  await pi.commands["reader-cue"].handler("off", ctx);
  assert.deepEqual(await run(msgs), msgs);
  await pi.commands["reader-cue"].handler("on", ctx);
  assert.equal((await run(msgs))[0].content, `q\n\n${CUE}`);
  await pi.commands["reader-cue"].handler("maybe", ctx);
  assert.deepEqual(ctx.notes.map((n: { msg: string; level: string }) => n.msg), ["reader-cue: off", "reader-cue: on", "usage: /reader-cue on|off"]);
});
