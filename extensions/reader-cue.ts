// reader-cue.ts — appends a fixed writing cue to every user-role message in each model request.
// Never shown in the transcript, never written to the session file: the hook only rewrites the
// copy that goes to the provider. `context_with_system`, not `context`: pi merges every system
// message into one head when a `context` handler returns a new list (runner.js
// restoreSystemMessages), which rewrites the cached prefix on any later prompt/tool delta;
// here non-user messages pass through by identity and stay where they are.
// Why the user turn and not the system prompt: measured across 8 cases, a user-turn cue cut writer-protecting sentences 1.19→1.88 (of 2)
// vs 1.62 for the same text in the system prompt (~/.pi/agent/tmp/density-exp/report.md).
// Every user message, not just the last: a cue that moves to the newest turn changes the
// previous user message, which busts the provider's prompt-cache prefix from there on every
// turn. Cost: ~150 tokens × user turns, all cached. Tool results and custom messages have
// other roles and are untouched. /reader-cue off|on toggles it for this session (default on).
// CUE is byte-identical to the measured text in ~/.pi/agent/tmp/density-exp/cue.md — do not edit.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CUE =
  "Writing check for this reply. Lead with the answer to the question actually asked, then only the facts the reader needs to act or verify. " +
  "Then delete every writer-protecting sentence — the ones that exist so the writer cannot be faulted, not so the reader can act: " +
  "a caveat attached to a number, a denial of a claim nobody made (\"not a benefit: X\"), a parenthetical that pre-answers an objection, " +
  "a justification of a choice already made, an \"honest\"/\"to be fair\" disclaimer, a restatement of what the reader already said. " +
  "Keep warnings, prerequisites, corrections, and every detail the user asked for. One point per sentence; short sentences over semicolon chains.";

export default function readerCue(pi: ExtensionAPI) {
  let on = true;

  pi.on("context_with_system", (event) => ({
    messages: !on
      ? event.messages
      : event.messages.map((m) => {
          if (m.role !== "user") return m;
          if (typeof m.content === "string") return { ...m, content: `${m.content}\n\n${CUE}` };
          const content = [...m.content];
          let i = content.length - 1;
          while (i >= 0 && content[i].type !== "text") i--;
          const last = content[i];
          if (last?.type === "text") content[i] = { ...last, text: `${last.text}\n\n${CUE}` };
          else content.push({ type: "text", text: CUE });
          return { ...m, content };
        }),
  }));

  pi.registerCommand("reader-cue", {
    description: "on|off: append the writing cue to user turns in model requests (default on)",
    handler: async (args, ctx) => {
      const a = args.trim();
      if (a === "on" || a === "off") on = a === "on";
      else if (a) return ctx.ui.notify("usage: /reader-cue on|off", "warning");
      ctx.ui.notify(`reader-cue: ${on ? "on" : "off"}`, "info");
    },
  });
}
