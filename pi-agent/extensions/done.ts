// /done — close this session for good: archive its transcript out of the
// /resume list (still greppable under ~/.pi/agent/sessions-archive/) and quit.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SESSIONS = join(AGENT_DIR, "sessions");
const ARCHIVE = join(AGENT_DIR, "sessions-archive");

export default function (pi: ExtensionAPI) {
  let archiveOnExit = false;

  pi.registerCommand("done", {
    description: "Archive this session (hide from /resume) and quit",
    handler: async (_args, ctx) => {
      archiveOnExit = true;
      ctx.ui.notify("Session will be archived on exit", "info");
      ctx.shutdown();
    },
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (!archiveOnExit || event.reason !== "quit") return;
    const file = ctx.sessionManager.getSessionFile();
    if (!file || !existsSync(file)) return;
    const dest = join(ARCHIVE, relative(SESSIONS, file));
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(file, dest);
  });
}
