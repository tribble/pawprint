// editor-smoke fixture — deterministic offline provider + echo tool for smoking
// extensions/editor.ts in a real TUI (notes/editor-smoke.sh) and for pinning its
// contract in tests (tests/editor-smoke.test.ts). No network, no credentials:
// streamSimple answers from the prompt text alone. Verdict scenarios key off the
// CURRENT draft only (the <draft> section of the Editor prompt), never the quoted
// conversation — an old marker in history must not retrigger a scenario.
//
// Every request is logged to $EDITOR_SMOKE_EVIDENCE/requests.jsonl (default
// ./editor-evidence) as request/complete/abort lines with durations, plus one line
// per smoke_echo execution — synthetic content only, safe to read back.
//
// Scenarios (user message prefix → behavior):
//   approve …      clean draft → APPROVE; renders once, no entry
//   reject …       defensive draft → REJECT → one redraft; collapsed "Original draft" (Ctrl+O)
//   malformed …    Editor answers without a verdict line → original + notice
//   insufficient … Editor answers INSUFFICIENT → original + notice
//   error …        Editor stream errors → original + notice
//   slow …         Editor waits $EDITOR_SMOKE_SLOW_MS (default 3s, abort-aware) → APPROVE
//   hang …         Editor never answers but honors abort → original at timeoutMs, or Esc
//   stubborn …     Editor ignores abort and answers REJECT ~$EDITOR_SMOKE_STUBBORN_MS
//                  (default 5s) after it — hard-race proof: the reply must release at
//                  timeout/Esc and the late verdict must be ignored
//   revstubborn …  REJECT, then the AUTHOR redraft ignores abort and answers late — the reply
//                  must release at timeout/Esc and the late redraft must be ignored
//   revfail …      REJECT, redraft stream errors → original
//   revempty …     REJECT, redraft empty → original
//   revlong …      REJECT, redraft far longer than the draft (delivered; no length cap)
//   toolcall …     commentary + smoke_echo tool call (runs once, logged), then final text
//   toolcall-stubborn …  commentary carrying SMOKE_STUBBORN + smoke_echo call: the editorial
//                  verdict on the commentary hangs — abort/no-source-execution proof
//   multiblock …   two text blocks → REJECT → aligned JSON-array redraft; originals kept
//   multiok …      two clean text blocks → APPROVE, untouched
//   noop …         REJECT, redraft returns the draft minus one trailing newline — the observed
//                  masquerade shape: no replacement, a "redraft changed nothing" notice, no entry
//   decorated …    Editor answers "**APPROVE**" — benign markdown decoration on a one-word
//                  verdict: accepted, draft renders, no notice
//   contradict …   Editor answers "**REJECT: tighten.** **APPROVE**" — contradictory verdicts in
//                  one decorated line: malformed, original + grammar-hint notice, no redraft
//
// Real-model synthetic drafts live in notes/editor-real-probe.mjs, not here — the fixture
// provider is always fake.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Assistant message; texts is the full ordered text-block list (empty → no text blocks). */
function msg(texts, model, stopReason = "stop", errorMessage, extraContent) {
  const content = [...texts.map((text) => ({ type: "text", text })), ...(extraContent ?? [])];
  return { role: "assistant", content, api: "openai-completions", provider: "smoke", model, usage: ZERO_USAGE, stopReason, errorMessage, timestamp: Date.now() };
}

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""));
const lastUser = (messages) => textOf(([...messages].reverse().find((m) => m.role === "user") ?? {}).content);
/** The <draft> section of an Editor/redraft prompt — the only place scenario markers count.
 *  Production bodies are one JSON string literal (lossless quoting) — decode them. A multi-section
 *  redraft draft (<block-N>) is returned raw; markers survive JSON encoding unescaped. */
const draftOf = (user) => {
  const body = /<draft>\n?([\s\S]*?)\n?<\/draft>/.exec(user)?.[1] ?? "";
  try {
    const v = JSON.parse(body);
    return typeof v === "string" ? v : body;
  } catch {
    return body;
  }
};

export default function editorSmoke(pi) {
  let reqSeq = 0;
  const log = (obj) => {
    const dir = process.env.EDITOR_SMOKE_EVIDENCE ?? join(process.cwd(), "editor-evidence");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "requests.jsonl"), JSON.stringify(obj) + "\n");
  };
  const slowMs = () => Number(process.env.EDITOR_SMOKE_SLOW_MS) || 3000;
  const stubbornMs = () => Number(process.env.EDITOR_SMOKE_STUBBORN_MS) || 5000;

  pi.registerTool({
    name: "smoke_echo",
    label: "smoke echo",
    description: "Smoke-test tool: echoes its text argument. Used by the toolcall scenario.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      log({ event: "tool", name: "smoke_echo", arguments: params, at: Date.now() });
      return { content: [{ type: "text", text: `echo: ${params.text}` }] };
    },
  });

  /** start → text_start → text_delta* → text_end → done, per block. Abort mid-stream ends with an aborted error. */
  function streamText(model, texts, { slow = false, signal } = {}) {
    const stream = createAssistantMessageEventStream();
    const queue = [{ type: "start", partial: msg([], model.id) }];
    const acc = [];
    texts.forEach((t, ci) => {
      const chunks = slow ? (t.match(/.{1,24}/gs) ?? [t]) : [t];
      let grown = "";
      queue.push({ type: "text_start", contentIndex: ci, partial: msg([...acc, ""], model.id) });
      for (const c of chunks) {
        grown += c;
        queue.push({ type: "text_delta", contentIndex: ci, delta: c, partial: msg([...acc, grown], model.id) });
      }
      queue.push({ type: "text_end", contentIndex: ci, content: t, partial: msg([...acc, t], model.id) });
      acc.push(t);
    });
    queue.push({ type: "done", reason: "stop", message: msg(acc, model.id) });
    let i = 0;
    const pump = () => {
      if (i > 0 && signal?.aborted) {
        stream.push({ type: "error", reason: "aborted", error: msg([], model.id, "aborted", "aborted") });
        return;
      }
      if (i < queue.length) {
        stream.push(queue[i++]);
        if (i < queue.length) setTimeout(pump, slow ? 60 : 0);
      }
    };
    queueMicrotask(pump);
    return stream;
  }

  function streamError(model, errorMessage) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({ type: "error", reason: "error", error: msg([], model.id, "error", errorMessage) }));
    return stream;
  }

  /** A verdict that arrives only after delayMs; an abort before that ends the stream aborted. */
  function streamSlowVerdict(model, text, delayMs, signal) {
    const stream = createAssistantMessageEventStream();
    const timer = setTimeout(() => {
      stream.push({ type: "start", partial: msg([], model.id) });
      stream.push({ type: "text_start", contentIndex: 0, partial: msg([""], model.id) });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg([text], model.id) });
      stream.push({ type: "done", reason: "stop", message: msg([text], model.id) });
    }, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      stream.push({ type: "error", reason: "aborted", error: msg([], model.id, "aborted", "aborted") });
    });
    return stream;
  }

  /**
   * Never answers until the signal fires. hang: honors abort. stubborn: ignores it and answers
   * lateText late anyway — the editor under test must have released the reply by then on its own.
   */
  function streamHang(model, { signal, ignoreAbort, req, logAbort, lateText = "REJECT: late verdict, must be ignored" }) {
    const stream = createAssistantMessageEventStream();
    let finished = false;
    const late = () => {
      if (finished) return;
      finished = true;
      stream.push({ type: "start", partial: msg([], model.id) });
      stream.push({ type: "text_start", contentIndex: 0, partial: msg([""], model.id) });
      stream.push({ type: "text_end", contentIndex: 0, content: lateText, partial: msg([lateText], model.id) });
      stream.push({ type: "done", reason: "stop", message: msg([lateText], model.id) });
    };
    signal?.addEventListener("abort", () => {
      if (finished) return;
      if (ignoreAbort) {
        logAbort?.();
        setTimeout(late, stubbornMs()).unref();
      } else {
        finished = true;
        stream.push({ type: "error", reason: "aborted", error: msg([], model.id, "aborted", "aborted") });
      }
    });
    // Backstop so a lost signal cannot wedge a smoke run forever (unref'd: never holds the process open).
    setTimeout(late, 30000).unref();
    return stream;
  }

  /** Commentary text followed by one tool call; done reason toolUse hands the call to the agent loop. */
  function streamToolCall(model, text, toolCall, signal) {
    const stream = createAssistantMessageEventStream();
    const withCall = (args) => msg([text], model.id, "toolUse", undefined, [{ ...toolCall, arguments: args }]);
    const queue = [
      { type: "start", partial: msg([], model.id, "toolUse") },
      { type: "text_start", contentIndex: 0, partial: msg([""], model.id, "toolUse") },
      { type: "text_delta", contentIndex: 0, delta: text, partial: msg([text], model.id, "toolUse") },
      { type: "text_end", contentIndex: 0, content: text, partial: msg([text], model.id, "toolUse") },
      { type: "toolcall_start", contentIndex: 1, partial: withCall({}) },
      { type: "toolcall_delta", contentIndex: 1, delta: JSON.stringify(toolCall.arguments), partial: withCall({}) },
      { type: "toolcall_end", contentIndex: 1, toolCall, partial: withCall(toolCall.arguments) },
      { type: "done", reason: "toolUse", message: withCall(toolCall.arguments) },
    ];
    let i = 0;
    const pump = () => {
      if (signal?.aborted) {
        stream.push({ type: "error", reason: "aborted", error: msg([], model.id, "aborted", "aborted") });
        return;
      }
      if (i < queue.length) {
        stream.push(queue[i++]);
        if (i < queue.length) setTimeout(pump, 25);
      }
    };
    queueMicrotask(pump);
    return stream;
  }

  function editorAnswer(user) {
    const draft = draftOf(user);
    if (draft.includes("SMOKE_HANG")) return { hang: true };
    if (draft.includes("SMOKE_STUBBORN")) return { stubborn: true };
    if (draft.includes("SMOKE_SLOW")) return { slowVerdict: "APPROVE" };
    if (draft.includes("SMOKE_MALFORMED")) return { text: "This looks okay to me, but what do I know." };
    if (draft.includes("SMOKE_INSUFFICIENT")) return { text: "INSUFFICIENT" };
    if (draft.includes("SMOKE_ERROR")) return { error: "smoke editor failure" };
    if (draft.includes("SMOKE_NOOP")) return { text: "REJECT: could be tighter" };
    if (draft.includes("SMOKE_DECORATED")) return { text: "**APPROVE**" };
    if (draft.includes("SMOKE_CONTRADICT")) return { text: "**REJECT: tighten.** **APPROVE**" };
    if (/SMOKE_(REJECT|REVFAIL|REVEMPTY|REVLONG|MULTIBLOCK|REVSTUBBORN)/.test(draft)) return { text: "REJECT: too defensive — lead with the answer, drop the hedging" };
    return { text: "APPROVE" };
  }

  function reviseAnswer(user) {
    const draft = draftOf(user);
    // The field-observed no-op: every word kept, one trailing newline dropped.
    if (draft.includes("SMOKE_NOOP")) return { text: draft.replace(/\n$/, "") };
    if (draft.includes("SMOKE_REVSTUBBORN")) return { stubbornLate: "The answer is 4. (late redraft, must be ignored)" };
    if (draft.includes("SMOKE_REVFAIL")) return { error: "smoke redraft failure" };
    if (draft.includes("SMOKE_REVEMPTY")) return { text: "" };
    if (draft.includes("SMOKE_REVLONG")) return { text: "The answer is 4. ".repeat(40).trim() };
    const blocks = user.match(/<block-\d+>/g)?.length ?? 0;
    if (blocks > 0) {
      const replies = ["The answer is 4.", "Supporting detail, kept."];
      return { text: JSON.stringify(Array.from({ length: blocks }, (_, i) => replies[i] ?? `Revised block ${i + 1}.`)) };
    }
    return { text: "The answer is 4." };
  }

  function authorAnswer(user, hasToolResult) {
    if (hasToolResult) return { texts: ["The answer is 4."] };
    if (user.includes("toolcall-stubborn")) {
      return { texts: ["SMOKE_STUBBORN: Let me check that with the echo tool."], toolCall: { type: "toolCall", id: "smoke-call-1", name: "smoke_echo", arguments: { text: "ping" } } };
    }
    if (user.includes("toolcall")) {
      return { texts: ["Let me check that with the echo tool."], toolCall: { type: "toolCall", id: "smoke-call-1", name: "smoke_echo", arguments: { text: "ping" } } };
    }
    if (user.includes("multiblock")) return { texts: ["SMOKE_MULTIBLOCK: Well, to be honest, part one might possibly be this.", "Part two adds a second detail."] };
    if (user.includes("multiok")) return { texts: ["The answer is 4.", "Computed with `node -e 'console.log(2 + 2)'`."] };
    if (user.includes("noop")) return { texts: ["SMOKE_NOOP: The answer is 4.\n"], slow: true };
    if (user.includes("decorated")) return { texts: ["SMOKE_DECORATED: The answer is 4."], slow: true };
    if (user.includes("contradict")) return { texts: ["SMOKE_CONTRADICT: The answer is 4."], slow: true };
    if (user.includes("reject")) return { texts: ["SMOKE_REJECT: Well, to be honest, I think there might be a chance that possibly the answer could be 4, though of course I may be wrong and it depends on many things."], slow: true };
    if (user.includes("malformed")) return { texts: ["SMOKE_MALFORMED: The answer is 4."], slow: true };
    if (user.includes("insufficient")) return { texts: ["SMOKE_INSUFFICIENT: The answer is 4."], slow: true };
    if (user.includes("error")) return { texts: ["SMOKE_ERROR: The answer is 4."], slow: true };
    if (user.includes("hang")) return { texts: ["SMOKE_HANG: The answer is 4."], slow: true };
    if (user.includes("revstubborn")) return { texts: ["SMOKE_REVSTUBBORN: Well, to be honest, the answer could possibly be 4, though I may be wrong."], slow: true };
    if (user.includes("stubborn")) return { texts: ["SMOKE_STUBBORN: The answer is 4."], slow: true };
    if (user.includes("slow")) return { texts: ["SMOKE_SLOW: The answer is 4."], slow: true };
    if (user.includes("revfail")) return { texts: ["SMOKE_REVFAIL: The answer is 4."], slow: true };
    if (user.includes("revempty")) return { texts: ["SMOKE_REVEMPTY: The answer is 4."], slow: true };
    if (user.includes("revlong")) return { texts: ["SMOKE_REVLONG: The answer is 4."], slow: true };
    return { texts: ["The answer is 4."], slow: true };
  }

  pi.registerProvider("smoke", {
    name: "smoke (offline editor test)",
    baseUrl: "http://127.0.0.1:9/",
    apiKey: "smoke",
    api: "openai-completions",
    models: [
      { id: "author", name: "smoke author", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 },
      { id: "editor", name: "smoke editor", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 },
    ],
    streamSimple(model, context, options) {
      const messages = context.messages;
      const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
      const user = lastUser(messages);
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      // A toolResult counts only for the turn after the LATEST user message — a stale one from
      // earlier history must not force the clean post-tool answer on every later prompt.
      const hasToolResult = messages.slice(lastUserIdx + 1).some((m) => m.role === "toolResult");
      const req = ++reqSeq;
      const t0 = Date.now();
      log({ req, event: "request", at: t0, model: model.id, roles: messages.map((m) => m.role), system, user });

      const a = system.includes("You are the Editor")
        ? editorAnswer(user)
        : system.includes("You wrote the message")
          ? reviseAnswer(user)
          : authorAnswer(user, hasToolResult);

      const stream = a.hang || a.stubborn || a.stubbornLate
        ? streamHang(model, {
            signal: options?.signal,
            ignoreAbort: Boolean(a.stubborn || a.stubbornLate),
            lateText: a.stubbornLate,
            req,
            logAbort: () => log({ req, event: "abort", at: Date.now(), ignored: true }),
          })
        : a.error
          ? streamError(model, a.error)
          : a.slowVerdict
            ? streamSlowVerdict(model, a.slowVerdict, slowMs(), options?.signal)
            : a.toolCall
              ? streamToolCall(model, a.texts[0], a.toolCall, options?.signal)
              : streamText(model, a.texts ?? [a.text], { slow: a.slow, signal: options?.signal });

      stream.result().then(
        (m) => log({ req, event: "complete", at: Date.now(), durationMs: Date.now() - t0, stopReason: m.stopReason, ...(m.errorMessage ? { errorMessage: m.errorMessage } : {}) }),
        () => log({ req, event: "complete", at: Date.now(), durationMs: Date.now() - t0, stopReason: "error", errorMessage: "stream rejected" }),
      );
      return stream;
    },
  });
}
