// herdr-agent-name.ts — keep the herdr agent name and its tab label equal to the pi session name.
// Session name == intercom address; this makes the herdr sidebar/agent list and the tab strip use
// the same name (herdr's default tab label is "1"). Tabs are pi-owned and follow the session name;
// workspace labels are deliberately NOT touched (human-owned).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function herdrAgentName(pi: ExtensionAPI) {
  const paneId = process.env.HERDR_PANE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  if (process.env.HERDR_ENV !== "1" || !paneId) return;

  let lastAgent: string | undefined; // names last applied; a failed rename stays unset and is retried on the next event
  let lastTab: string | undefined;
  let hasUI = false;
  const rename = async (ctx: { hasUI?: boolean }) => {
    hasUI ||= ctx.hasUI === true;
    if (!hasUI) return; // `pi --print` children inherit HERDR_PANE_ID; only the pane's own TUI may rename it
    const name = pi.getSessionName()?.trim();
    if (!name) return;
    if (name !== lastAgent) {
      const r = await pi.exec(herdr, ["agent", "rename", paneId, name]);
      if (r.code !== 0) return; // the tab follows a successful agent rename
      lastAgent = name;
    }
    if (tabId && name !== lastTab) {
      const r = await pi.exec(herdr, ["tab", "rename", tabId, name]);
      if (r.code === 0) lastTab = name; // a failed tab rename never undoes the agent rename
    }
  };

  // pi emits session events without awaiting handlers; run one pass at a time so a pending rename
  // is never taken for an applied one and an older name can't land after a newer one.
  let chain: Promise<void> = Promise.resolve();
  const sync = (_e: unknown, ctx: { hasUI?: boolean }) => (chain = chain.catch(() => {}).then(() => rename(ctx)));

  pi.on("session_start", sync); // `pi --name X` and resumed named sessions
  pi.on("session_info_changed", sync);
}
