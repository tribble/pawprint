// herdr-agent-name.ts — one name per agent: pi session name = herdr agent name = tab label = intercom address.
// herdr only accepts agent names matching [a-z][a-z0-9_-]{0,31}, so a free-form session name
// ("Workflow Improvements") used to fail the agent rename, leave the tab at herdr's default "1" and
// make the intercom address (= session name) differ from anything visible in the UI. Now the session
// name itself is normalised to that slug (`pi.setSessionName`) once herdr has accepted it, so the
// sidebar, the tab strip, `/session` and intercom all show the same string. Tabs are pi-owned and
// follow the session name; workspace labels are deliberately NOT touched (human-owned).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// herdr's agent-name shape: lowercase; `_` and `-` kept; anything else → `-`; must start with a letter;
// ≤ 32 chars. Idempotent (slug(slug(x)) === slug(x)), which is what lets the session rename settle.
export function slug(name: string): string | null {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return s || null;
}

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
    const raw = pi.getSessionName()?.trim();
    if (!raw) return;
    const name = slug(raw);
    if (!name) return;
    if (name !== lastAgent) {
      const r = await pi.exec(herdr, ["agent", "rename", paneId, name]);
      if (r.code !== 0) return; // the session and the tab follow a successful agent rename (herdr may refuse a taken name)
      lastAgent = name;
    }
    // The session follows herdr, unless the user renamed it during the await (that name gets its own pass).
    // setSessionName fires session_info_changed, which re-enters this chain; the next pass finds the
    // name already equal to its slug and stops.
    if (name !== raw && pi.getSessionName()?.trim() === raw) pi.setSessionName(name);
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
