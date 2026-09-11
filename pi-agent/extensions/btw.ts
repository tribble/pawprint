// btw.ts — /btw <question>: ask a side model a quick question about this conversation.
// The exchange renders inline as a dimmed card (pi.appendEntry + registerEntryRenderer) and
// never enters the main model's context. The side model sees what the main model sees —
// buildContextEntries() (compaction applied; getBranch() is raw history and overflows) —
// serialized to text the way pi's own compaction does, so mid-turn tool calls without
// results and provider-specific message shapes can't break the call. Earlier /btw Q/As on
// this branch (getBranch: compaction's cut would drop them, and its summary never had them)
// are replayed as a thread so follow-ups work.
// Optional ~/.pi/agent/configs/btw.json: {"model": "provider/model-id"} (id may contain slashes).
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir, serializeConversation, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { Message, Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface BtwEntry { q: string; a: string; model: string; at: number }

const SYSTEM_PROMPT =
  "I'm a side channel: the user quotes the conversation so far with their main coding assistant, then asks me a quick question about it. " +
  "The main assistant never sees this exchange, so I don't address it or continue its work — I answer the user directly and concisely.";

export default function btw(pi: ExtensionAPI) {
  let warned = false;
  let busy = false; // one question at a time: overlapping calls would share the status line and persist out of order

  // configs/btw.json {"model": "provider/id"} → that model; no file → the session model; bad file → session model, warn once.
  function pickModel(ctx: ExtensionCommandContext): Model<any> | undefined {
    const file = join(getAgentDir(), "configs", "btw.json");
    if (!existsSync(file)) return ctx.model;
    let spec = "";
    try { spec = String(JSON.parse(readFileSync(file, "utf8")).model ?? ""); } catch { /* unparseable: warn below */ }
    const slash = spec.indexOf("/");
    const found = slash > 0 ? ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
    if (!found && !warned) {
      warned = true;
      ctx.ui.notify(`btw: model ${JSON.stringify(spec)} from ${file} not found — using the session model`, "warning");
    }
    return found ?? ctx.model;
  }

  pi.registerEntryRenderer<BtwEntry>("btw", (entry, _opts, theme) => {
    const { q = "", a = "", model = "" } = entry.data ?? {};
    const card = [theme.fg("dim", `btw · ${model}`), theme.fg("dim", `Q: ${q}`), theme.fg("muted", a)].join("\n");
    return new Text(card, 1, 1, (t) => theme.bg("customMessageBg", t));
  });

  pi.registerCommand("btw", {
    description: "Ask a side model a quick question about this conversation (never enters the main context)",
    handler: async (args, ctx) => {
      const q = args.trim();
      if (!q) return ctx.ui.notify("usage: /btw <question>", "warning");
      if (busy) return ctx.ui.notify("btw: still answering the previous question", "warning");
      const model = pickModel(ctx);
      if (!model) return ctx.ui.notify("btw: no model selected", "error");
      const name = `${model.provider}/${model.id}`;

      const sm = ctx.sessionManager;
      const transcript = serializeConversation(convertToLlm(sm.buildContextEntries().flatMap(sessionEntryToContextMessages)));
      const prior = sm.getBranch().flatMap((e) => (e.type === "custom" && e.customType === "btw" && e.data ? [e.data as BtwEntry] : []));
      const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      // ponytail: whole transcript every call; trim to the side model's contextWindow if "prompt too long" shows up.
      const messages: Message[] = [];
      [...prior, { q, a: "" }].forEach((t, i) => {
        messages.push(user(i === 0 ? `<conversation>\n${transcript}\n</conversation>\n\n${t.q}` : t.q));
        if (t.a) {
          messages.push({
            role: "assistant", content: [{ type: "text", text: t.a }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          });
        }
      });

      const leaf = sm.getLeafId();
      const known = new Set(leaf ? [] : sm.getEntries().map((e) => e.id)); // null leaf: a pre-existing entry on the final branch means we navigated
      busy = true;
      ctx.ui.setStatus("btw", `btw → ${name} …`);
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new Error(auth.error);
        const provider = ctx.modelRegistry.getProvider(model.provider);
        if (!provider) throw new Error(`no provider ${model.provider}`);
        // env carries the gateway's account/gateway ids for baseUrl substitution; baseUrl is auth's own override.
        const r = await provider
          .streamSimple(auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model, { systemPrompt: SYSTEM_PROMPT, messages }, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, reasoning: "low" })
          .result();
        if (r.stopReason === "error") throw new Error(r.errorMessage ?? "request failed");
        const a = r.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim();
        if (!a) throw new Error("empty response");
        // /tree (or /new) while we waited: the answer is about a branch that is no longer current.
        const branch = sm.getBranch();
        if (leaf ? !branch.some((e) => e.id === leaf) : branch.some((e) => known.has(e.id))) throw new Error("branch changed while answering — answer dropped");
        pi.appendEntry<BtwEntry>("btw", { q, a, model: name, at: Date.now() });
      } catch (e) {
        ctx.ui.notify(`btw: ${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        busy = false;
        ctx.ui.setStatus("btw", undefined);
      }
    },
  });
}
