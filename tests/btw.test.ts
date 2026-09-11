// btw.ts: /btw builds the side model's context from buildContextEntries (getBranch is raw
// history and only supplies the small btw thread), forwards auth incl. env, replays earlier
// btw Q/As, persists a "btw" entry on success only.
// Model + provider are fakes on ctx.modelRegistry; config comes from the getAgentDir stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "./stubs/pi-coding-agent.mjs";
import { makePi, makeCtx } from "./harness.mjs";
import btw from "../pi-agent/extensions/btw.ts";

const msg = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });
const ok = { stopReason: "stop", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "the answer" }] };

interface Boot {
  entries?: unknown[]; // buildContextEntries (compaction applied)
  branch?: unknown[]; // getBranch (raw); defaults to entries
  leaf?: string | null;
  auth?: unknown;
  result?: unknown | (() => Promise<unknown>);
  find?: (p: string, id: string) => unknown;
}

function boot(opts: Boot = {}) {
  const pi = makePi();
  btw(pi);
  const ctx = makeCtx();
  const calls: { model: any; req: any; o: any }[] = [];
  ctx.sessionManager.buildContextEntries = () => opts.entries ?? [];
  ctx.sessionManager.getBranch = () => opts.branch ?? opts.entries ?? [];
  ctx.sessionManager.getLeafId = () => opts.leaf ?? null;
  ctx.modelRegistry = {
    find: opts.find ?? (() => undefined),
    getApiKeyAndHeaders: async () => opts.auth ?? { ok: true, apiKey: "k", headers: { h: "1" }, env: { CF_GATEWAY: "g" } },
    getProvider: () => ({
      streamSimple: (model: any, req: any, o: any) => {
        calls.push({ model, req, o });
        return { result: async () => (typeof opts.result === "function" ? opts.result() : opts.result ?? ok) };
      },
    }),
  };
  return { pi, ctx, calls, run: (q: string) => pi.commands.btw.handler(q, ctx) };
}

// configs/btw.json lives under the (stubbed) agent dir; each call gets a fresh dir.
function agentDirWith(config?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "btw-agent-"));
  if (config !== undefined) {
    mkdirSync(join(dir, "configs"));
    writeFileSync(join(dir, "configs", "btw.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  setAgentDir(dir);
}

test("empty question → usage notify, no stream, no entry", async () => {
  agentDirWith();
  const { ctx, calls, pi, run } = boot();
  await run("   ");
  assert.deepEqual(ctx.notes, [{ msg: "usage: /btw <question>", level: "warning" }]);
  assert.equal(calls.length, 0);
  assert.equal(pi.state.entries.length, 0);
});

test("context: transcript from buildContextEntries (compaction summary leads, raw pre-cut history excluded); whole-branch btw thread replayed in order", async () => {
  agentDirWith();
  const kept = [
    { type: "compaction", summary: "SUMMARY-OF-OLD-STUFF" },
    msg("user", "hello there"),
    { type: "custom", customType: "other-ext", data: { x: 1 } },
    msg("assistant", "hi, how can I help"),
    { type: "custom", customType: "btw", data: { q: "second side q", a: "second side a", model: "m", at: 2 } },
    msg("user", "please refactor"),
  ];
  const { calls, run } = boot({
    entries: kept,
    // raw history: ANCIENT messages were compacted away, but the btw asked back then still belongs to the thread
    branch: [msg("user", "ANCIENT-MESSAGE"), { type: "custom", customType: "btw", data: { q: "first side q", a: "first side a", model: "m", at: 1 } }, ...kept],
  });
  await run("what did I ask first?");
  assert.equal(calls.length, 1);
  const { req } = calls[0];
  assert.ok(req.systemPrompt.length > 0);
  assert.deepEqual(req.messages.map((m: any) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  const lead = req.messages[0].content[0].text as string;
  assert.ok(lead.startsWith("<conversation>\n"), "conversation block leads");
  const summaryAt = lead.indexOf("SUMMARY-OF-OLD-STUFF");
  const helloAt = lead.indexOf("hello there");
  assert.ok(summaryAt >= 0 && helloAt >= 0 && summaryAt < helloAt, `compaction summary present and first: ${summaryAt} < ${helloAt}`);
  assert.ok(lead.includes("[Assistant]: hi, how can I help") && lead.includes("please refactor"));
  assert.ok(!lead.includes("ANCIENT-MESSAGE"), "raw history behind the compaction cut is not context");
  assert.ok(!lead.includes('"x":1') && !lead.includes("side a"), "custom entries never enter the transcript");
  assert.ok(lead.endsWith("</conversation>\n\nfirst side q"), "earliest btw question follows the block");
  assert.deepEqual(req.messages.slice(1).map((m: any) => m.content[0].text), ["first side a", "second side q", "second side a", "what did I ask first?"]);
});

test("one question at a time: an overlapping /btw is refused without a stream; /tree away mid-request drops the answer", async () => {
  agentDirWith();
  // every stream resolves after 50ms, so a missing guard fails the assertions instead of hanging
  const { ctx, calls, pi, run } = boot({ result: () => new Promise((r) => setTimeout(() => r(ok), 50)) });
  const first = run("slow one");
  await run("impatient");
  assert.deepEqual(ctx.notes, [{ msg: "btw: still answering the previous question", level: "warning" }]);
  assert.equal(calls.length, 1);
  assert.equal(ctx.statuses.get("btw"), "btw → anthropic/claude-test …");
  await first;
  assert.equal(pi.state.entries.length, 1);
  assert.equal(pi.state.entries[0].data.q, "slow one");
  assert.equal(ctx.statuses.size, 0);
  await run("again"); // guard released
  assert.equal(calls.length, 2);

  const entry = (id: string) => ({ type: "message", id, message: { role: "user", content: [] } });
  const navigate = async (b: Boot, laterBranch: unknown[]) => {
    const s = boot({ ...b, result: () => Promise.resolve(ok) });
    const pending = s.run("q");
    s.ctx.sessionManager.getBranch = () => laterBranch; // what the branch looks like once the answer arrives
    await pending;
    return s;
  };
  const moved = await navigate({ leaf: "L1", branch: [entry("L1")] }, [entry("OTHER")]);
  assert.equal(moved.pi.state.entries.length, 0);
  assert.deepEqual(moved.ctx.notes.at(-1), { msg: "btw: branch changed while answering — answer dropped", level: "error" });
  const advanced = await navigate({ leaf: "L1", branch: [entry("L1")] }, [entry("L1"), entry("L2")]); // main turn appended under our leaf
  assert.equal(advanced.pi.state.entries.length, 1);

  // null leaf (empty session or root re-edit): growing a fresh branch is fine, landing on a pre-existing one is not
  const known = boot({ leaf: null, branch: [] });
  known.ctx.sessionManager.getEntries = () => [entry("OLD-ROOT")];
  const p1 = known.run("q");
  known.ctx.sessionManager.getBranch = () => [entry("OLD-ROOT")];
  await p1;
  assert.equal(known.pi.state.entries.length, 0);
  assert.ok(known.ctx.notes.at(-1).msg.includes("branch changed"));
  const fresh = await navigate({ leaf: null, branch: [] }, [entry("NEW-ROOT")]);
  assert.equal(fresh.pi.state.entries.length, 1);
});

test("stream options carry apiKey, headers, env from getApiKeyAndHeaders; reasoning low; auth baseUrl overrides the model's", async () => {
  agentDirWith();
  const { calls, run } = boot({ auth: { ok: true, apiKey: "k", headers: { h: "1" }, env: { CLOUDFLARE_GATEWAY_ID: "gw" }, baseUrl: "https://gw.example" } });
  await run("q");
  assert.deepEqual(calls[0].o, { apiKey: "k", headers: { h: "1" }, env: { CLOUDFLARE_GATEWAY_ID: "gw" }, reasoning: "low" });
  assert.equal(calls[0].model.baseUrl, "https://gw.example");
  assert.equal(calls[0].model.id, "claude-test");
});

test("config: provider/id (id with slashes) resolves via find", async () => {
  agentDirWith({ model: "cloudflare-ai-gateway/accounts/fireworks/models/kimi-k3" });
  const seen: string[][] = [];
  const { calls, ctx, pi, run } = boot({
    find: (p, id) => {
      seen.push([p, id]);
      return { provider: p, id, api: "openai-completions" };
    },
  });
  await run("q");
  assert.deepEqual(seen, [["cloudflare-ai-gateway", "accounts/fireworks/models/kimi-k3"]]);
  assert.equal(calls[0].model.id, "accounts/fireworks/models/kimi-k3");
  assert.equal(pi.state.entries[0].data.model, "cloudflare-ai-gateway/accounts/fireworks/models/kimi-k3");
  assert.deepEqual(ctx.notes, []);
});

test("config: unresolvable model → ctx.model + one warning across calls; no file → ctx.model silently", async () => {
  agentDirWith({ model: "nope/missing" });
  const { calls, ctx, run } = boot();
  await run("q1");
  await run("q2");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.model.id === "claude-test"));
  assert.equal(ctx.notes.filter((n: any) => n.level === "warning").length, 1);
  assert.ok(ctx.notes[0].msg.includes("nope/missing") && ctx.notes[0].msg.includes("btw.json"));

  agentDirWith("{not json");
  const bad = boot();
  await bad.run("q");
  assert.equal(bad.ctx.notes[0].level, "warning");

  agentDirWith();
  const none = boot();
  await none.run("q");
  assert.equal(none.calls[0].model.id, "claude-test");
  assert.deepEqual(none.ctx.notes, []);
});

test("error stop → error notify, no entry, status cleared", async () => {
  agentDirWith();
  const { ctx, pi, run } = boot({ result: { stopReason: "error", errorMessage: "prompt too long", content: [] } });
  await run("q");
  assert.deepEqual(ctx.notes, [{ msg: "btw: prompt too long", level: "error" }]);
  assert.equal(pi.state.entries.length, 0);
  assert.equal(ctx.statuses.size, 0);

  const noAuth = boot({ auth: { ok: false, error: "No API key found" } });
  await noAuth.run("q");
  assert.deepEqual(noAuth.ctx.notes, [{ msg: "btw: No API key found", level: "error" }]);
  assert.equal(noAuth.calls.length, 0);
});

test("success → appendEntry('btw', {q, a, model, at}); text blocks only; renderer shows model, Q and answer", async () => {
  agentDirWith();
  const { ctx, pi, run } = boot();
  const before = Date.now();
  await run("  why?  ");
  assert.deepEqual(ctx.notes, []);
  assert.equal(pi.state.entries.length, 1);
  const { type, data } = pi.state.entries[0];
  assert.equal(type, "btw");
  assert.deepEqual({ ...data, at: undefined }, { q: "why?", a: "the answer", model: "anthropic/claude-test", at: undefined });
  assert.ok(data.at >= before && data.at <= Date.now());
  assert.equal(ctx.statuses.size, 0);

  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s };
  const card = pi.entryRenderers.btw({ data }, { expanded: false }, theme);
  assert.equal(card.text, "btw · anthropic/claude-test\nQ: why?\nthe answer");
});
