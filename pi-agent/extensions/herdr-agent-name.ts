// herdr-agent-name.ts — keep the herdr agent name equal to the pi session name.
// Session name == intercom address; this makes the herdr sidebar/agent list use the same
// name. Workspace labels are deliberately NOT touched (human-owned).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function herdrAgentName(pi: ExtensionAPI) {
  const paneId = process.env.HERDR_PANE_ID;
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  if (process.env.HERDR_ENV !== "1" || !paneId) return;

  let last: string | undefined;
  let hasUI = false;
  const sync = async (_e: unknown, ctx: { hasUI?: boolean }) => {
    hasUI ||= ctx.hasUI === true;
    if (!hasUI) return; // `pi --print` children inherit HERDR_PANE_ID; only the pane's own TUI may rename it
    const name = pi.getSessionName()?.trim();
    if (!name || name === last) return;
    last = name;
    const r = await pi.exec(herdr, ["agent", "rename", paneId, name]);
    if (r.code !== 0) last = undefined; // retry on next event
  };

  pi.on("session_start", sync); // `pi --name X` and resumed named sessions
  pi.on("session_info_changed", sync);
}
