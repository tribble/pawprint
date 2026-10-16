// /recap: a detached summary, persisted and rendered without entering the main model's context.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

interface RecapEntry { text: string; model: string }

const INSTRUCTIONS = `Recap this session for me — I'm returning after time away. Use only what's already in this conversation; don't run tools or start new work to produce it.

Reply with exactly these three sections, in this order, with these exact headings, short and plain:

**Where we left off:** What we're working toward, what's done, and where it stands.

**What's next:** The next meaningful step and anything blocking it.

**What I need from you:** Decisions or answers I need to give so you can proceed, each with your recommendation. If nothing is needed, say so.

Mention a prior decision only when it affects what happens next. Leave out PR, branch, and process bookkeeping unless it is the blocker.`;

export default function recap(pi: ExtensionAPI) {
  let pending: AbortController | undefined;
  pi.on("session_tree", () => { pending?.abort(); });
  pi.on("session_shutdown", () => { pending?.abort(); });

  pi.registerEntryRenderer<RecapEntry>("recap", (entry, _opts, theme) => {
    const view = new Container();
    view.addChild(new Text(theme.fg("dim", `recap · ${entry.data?.model ?? ""}`), 1, 0));
    view.addChild(new Markdown(entry.data?.text ?? "", 1, 0, getMarkdownTheme()));
    return view;
  });

  pi.registerCommand("recap", {
    description: "Recap this session without interrupting the agent; /recap cancel stops the recap",
    handler: async (args, ctx) => {
      const { ui } = ctx;
      if (args.trim() === "cancel") {
        if (pending) pending.abort();
        else ui.notify("recap: nothing is running", "info");
        return;
      }
      if (args.trim()) return ui.notify("usage: /recap [cancel]", "warning");
      if (pending) return ui.notify("recap: already running — /recap cancel to stop it", "warning");
      if (!ctx.isIdle()) return ui.notify("recap: agent is working — retry /recap when it finishes", "warning");
      const model = ctx.model;
      if (!model) return ui.notify("recap: no model selected", "error");
      const name = `${model.provider}/${model.id}`;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
      pending = controller;
      ui.setStatus("recap", `recap → ${name} …`);
      void (async () => {
        try {
          const sm = ctx.sessionManager;
          const sessionId = sm.getSessionId();
          const leaf = sm.getLeafId();
          // shortcut: request-time extension transforms are omitted; revisit if stored-context summaries prove misleading.
          const messages = structuredClone(convertToLlm(sm.buildSessionProjection().messages));
          const response = await ctx.modelRegistry.streamSimple(model, {
            messages: [...messages, { role: "user", content: INSTRUCTIONS, timestamp: Date.now() }],
          }, { sessionId, signal, reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel ?? "low", maxTokens: 2048, maxRetries: 0 }).result();
          signal.throwIfAborted();
          if (response.stopReason === "aborted") {
            ui.notify("recap: cancelled", "info");
            return;
          }
          if (response.stopReason === "error") throw new Error(response.errorMessage ?? "request failed");
          if (response.stopReason === "length") throw new Error("recap hit the 2048-token output limit — run /recap to retry");
          if (response.stopReason !== "stop" || response.content.some((block) => block.type === "toolCall")) {
            throw new Error("model did not finish a text recap; no tools were run");
          }
          const text = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim();
          if (!text) throw new Error("empty response");
          if (!ctx.isIdle() || ctx.sessionManager.getSessionId() !== sessionId || sm.getLeafId() !== leaf ||
              ctx.model?.provider !== model.provider || ctx.model.id !== model.id) {
            throw new Error("session, branch or model changed — answer dropped; run /recap again");
          }
          pi.appendEntry<RecapEntry>("recap", { text, model: name });
        } catch (error) {
          if (signal.aborted) ui.notify(controller.signal.aborted ? "recap: cancelled" : "recap: timed out — run /recap to retry", "info");
          else ui.notify(`recap: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          pending = undefined;
          ui.setStatus("recap", undefined);
        }
      })();
    },
  });
}
