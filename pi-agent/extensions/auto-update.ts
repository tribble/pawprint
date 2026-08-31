// auto-update.ts — daily background self-update: pi itself + all packages.
// session_start: updates silently, notifies only. Reload on event-context is
// deliberately not exposed by pi ("safe only in user-initiated commands"), so
// applying extension updates is one `/reload` — or `/update` to do it all now.
// A pi self-update always applies on next launch (core code can't hot-swap).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE = join(getAgentDir(), ".auto-update.json");
const LOCK = STATE + ".lock";
const TTL_MS = 20 * 60 * 60 * 1000; // ~daily

interface UpdateResult {
  piUpdated: boolean;
  extChanged: boolean;
  failed: boolean;
}

async function runUpdates(pi: ExtensionAPI): Promise<UpdateResult> {
  let piUpdated = false;
  let extChanged = false;
  let failed = false;
  try {
    const self = await pi.exec("pi", ["update", "--self"], { timeout: 180_000 });
    piUpdated = self.code === 0 && !/already up to date/i.test(self.stdout);
    failed ||= self.code !== 0;
  } catch {
    failed = true; // offline etc.
  }
  try {
    const ext = await pi.exec("pi", ["update", "--extensions", "--no-approve"], { timeout: 300_000 });
    extChanged = ext.code === 0 && /^Updating /m.test(ext.stdout);
    failed ||= ext.code !== 0;
  } catch {
    failed = true;
  }
  return { piUpdated, extChanged, failed };
}

function summary({ piUpdated, extChanged }: UpdateResult): string {
  const parts: string[] = [];
  if (extChanged) parts.push("packages updated — /reload to apply");
  if (piUpdated) parts.push("pi updated — takes effect next launch");
  return parts.join("; ");
}

export default function autoUpdate(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    let st: { lastRun?: string } = {};
    try {
      st = JSON.parse(readFileSync(STATE, "utf8"));
    } catch { /* first run */ }
    if (st.lastRun && Date.now() - Date.parse(st.lastRun) < TTL_MS) return;

    // Multiple panes launch together (herdr) — only one session updates.
    try {
      mkdirSync(LOCK);
    } catch {
      return;
    }

    void (async () => {
      try {
        const result = await runUpdates(pi);
        try {
          writeFileSync(STATE, JSON.stringify({ lastRun: new Date().toISOString() }));
        } catch { /* ignore */ }
        const note = summary(result);
        if (ctx.hasUI && note) ctx.ui.notify(`auto-update: ${note}`, "info");
      } finally {
        rmSync(LOCK, { recursive: true, force: true });
      }
    })();
  });

  // The sanctioned reload path: command handlers get reload(); event handlers don't.
  pi.registerCommand("update", {
    description: "Update pi + all packages now, then reload to apply",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.notify("Updating pi + packages…", "info");
      const result = await runUpdates(pi);
      if (result.failed) ctx.ui.notify("auto-update: part of the update failed — run `pi update --all` in a shell to see why", "warning");
      const note = summary(result);
      if (result.extChanged) {
        ctx.ui.notify(note, "info");
        await ctx.reload();
      } else {
        ctx.ui.notify(note || "Everything up to date.", "info");
      }
    },
  });
}
