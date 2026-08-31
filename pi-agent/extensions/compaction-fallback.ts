// compaction-fallback.ts — when compaction's summarization call fails (provider
// refusal, overload), switch to a cross-family model and retry once, then restore.
// Fixes the stranded-session failure: threshold compaction refused → every turn
// truncates (context ~full) → compaction retried → refused again → dead session.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

// Ordered preference by id substring; first match in the session's scoped models wins.
// Cross-family on purpose: a same-family fallback may trip the same refusal classifier.
const PREFER = ["gpt-5.6-sol", "kimi", "deepseek", "glm", "minimax"];

export default function compactionFallback(pi: ExtensionAPI) {
  let restoreAfter: Model<any> | null = null; // non-null while a fallback retry is in flight

  pi.on("session_compact_failed", async (event, ctx: ExtensionContext) => {
    if (event.aborted) return;

    if (restoreAfter) {
      // The fallback's own attempt failed too — restore and fail through.
      const orig = restoreAfter;
      restoreAfter = null;
      await pi.setModel(orig);
      return;
    }

    const current = ctx.model;
    if (!current) return;
    const candidates = ctx.scopedModels.map((s) => s.model).filter((m) => m.id !== current.id);
    const fallback =
      PREFER.map((p) => candidates.find((m) => m.id.includes(p))).find(Boolean) ?? candidates[0];
    if (!fallback) return; // no scoping configured / no alternative — nothing we can do

    if (await pi.setModel(fallback)) {
      restoreAfter = current;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Compaction failed (${event.errorMessage ?? "unknown"}; origin: ${event.reason}) — retrying with ${fallback.id}. ` +
            (event.willRetry ? "Re-send your message after it completes." : ""),
          "warning"
        );
      }
      ctx.compact({}); // retry compaction on the fallback model
    }
  });

  pi.on("session_compact", (_event, _ctx) => {
    if (restoreAfter) {
      void pi.setModel(restoreAfter);
      restoreAfter = null;
    }
  });
}
