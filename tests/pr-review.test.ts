// pr-review.ts: open_pr_review hands pr-review-open this session's intercom ID as the
// coordinator (pi-<sha256(session id)[0:32]>, the pi-subagents formula), never its name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePi, makeCtx } from "./harness.mjs";
import prReview from "../pi-agent/extensions/pr-review.ts";

// sha256("sess-1").hex[0:32], precomputed: the test must not share the implementation's formula.
const SESSION_ID = "sess-1";
const MY_ID = "pi-abe633f3a47a2758174eabe9160daf36";
const opened = (coordinator: string) => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, tab_id: "w:t2", pane_id: "w:p2", repo: "o/r", pr: 7, coordinator }),
  stderr: "",
});

function openTool(execImpl: unknown) {
  const pi = makePi({ execImpl, sessionName: "Workflow Improvements" }); // a name is never what gets passed
  prReview(pi);
  const ctx = makeCtx({ sessionId: SESSION_ID });
  return { pi, run: (params: Record<string, unknown>) => pi.tools.open_pr_review.execute("c1", params, undefined, undefined, ctx) };
}

test("open_pr_review: --coordinator is this session's intercom ID derived from the session id", async () => {
  const { pi, run } = openTool(async () => opened(MY_ID));
  const r = await run({ pr: "o/r#7" });
  assert.deepEqual(pi.execCalls, [["pr-review-open", "--require-coordinator", "--coordinator", MY_ID, "o/r#7"]]);
  assert.equal(r.details.coordinator, MY_ID);
  assert.match(r.content[0].text, new RegExp(`Opened PR review for o/r#7 in herdr tab w:t2 \\(pane w:p2\\).*"${MY_ID}"`));
});

test("open_pr_review: an explicit coordinator (name or id) wins; focus:false adds --no-focus", async () => {
  const { pi, run } = openTool(async () => opened("someone-else"));
  await run({ pr: "o/r#7", coordinator: " someone-else ", focus: false });
  assert.deepEqual(pi.execCalls, [["pr-review-open", "--require-coordinator", "--coordinator", "someone-else", "--no-focus", "o/r#7"]]);
});

test("open_pr_review: pr-review-open failing surfaces its stderr", async () => {
  const { run } = openTool(async () => ({ code: 1, stdout: "", stderr: "pr-review-open: PR not found: o/r#7" }));
  await assert.rejects(run({ pr: "o/r#7" }), /pr-review-open failed: pr-review-open: PR not found: o\/r#7/);
});
