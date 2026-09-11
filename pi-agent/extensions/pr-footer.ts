// pr-footer.ts — "⚑ N need review" in the pi footer, read from pr-watch's cache.
// The pr-watch daemon (~/work/pi/pr-watch) polls GitHub and writes
// ~/.local/state/pr-watch/state.json; this only reads that file — on
// session_start and every 5 minutes — and never touches GitHub or herdr.
// N counts non-draft PRs that directly request the user's review (the same
// definition `pr-watch status` uses). Missing/unreadable cache → status cleared.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE_FILE = join(
  process.env.PR_WATCH_STATE_DIR || join(homedir(), ".local", "state", "pr-watch"),
  "state.json",
);
const EVERY_MS = 5 * 60_000;

export async function needsReviewCount(file = STATE_FILE): Promise<number> {
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as { needs_review?: { isDraft?: boolean }[] };
    if (!Array.isArray(state.needs_review)) return 0;
    return state.needs_review.filter((pr) => !pr.isDraft).length;
  } catch {
    return 0;
  }
}

export default function prFooter(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let live = false; // false after session_shutdown: ctx is invalid from then on

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    live = true;
    const refresh = async () => {
      const n = await needsReviewCount();
      if (!live) return; // shutdown raced the read (reload/new/resume/fork)
      ctx.ui.setStatus("prs", n > 0 ? `⚑ ${n} need${n === 1 ? "s" : ""} review` : undefined);
    };
    await refresh();
    if (!live) return;
    clearInterval(timer);
    timer = setInterval(refresh, EVERY_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", () => {
    live = false;
    clearInterval(timer);
  });
}
