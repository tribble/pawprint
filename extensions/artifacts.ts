// artifacts.ts — the agent's own list of what it made this session; Enter opens an item.
// Shaped by four answers from the owner: the list lives in the agent's session (not cross-agent,
// not in herdr — like a worktree keeps repo work out of the repo); an item is OPENED, never copied
// or jumped to; "old" means the agent is done working with it, so the agent manages its own list
// (`artifact done`); a long list is a smell — past 7 items the tool result says so, project files
// belong in a worktree.
// Tool `artifact` {action: add|done, ref, title?, note?}. Kind is derived from the ref, never asked:
// github …/pull/N → PR, an http(s) URL with /issues/ → issue, other http(s) → link, a path ending
// .md → doc, any other path → file. Paths are stored absolute (~ and cwd-relative accepted).
// Every call appends a TUI-only "artifact" session entry (pi.appendEntry: survives resume, never
// enters the model's context); the list is the replay of those entries on the current branch, so
// /tree and /fork see the list as of that point. `add` on a known ref updates title/note in place.
// /artifacts: Enter opens — doc → inline via md.ts's md-view renderer, PR/issue/link → `open <url>`,
// file → `open <path>` (macOS picks the app); d drops the item; esc closes.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { Type } from "typebox";
import { expandPath, tildePath, viewMarkdown } from "./md.ts";

type Kind = "PR" | "issue" | "link" | "doc" | "file";
interface Artifact { ref: string; title?: string; note?: string }
type ArtifactEntry = ({ action: "add" } & Artifact) | { action: "done"; ref: string };

const NUDGE_AT = 7;
const isUrl = (ref: string) => /^https?:\/\//.test(ref);
const GITHUB = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/;

export function kindOf(ref: string): Kind {
  if (!isUrl(ref)) return ref.endsWith(".md") ? "doc" : "file";
  if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(ref)) return "PR";
  return ref.includes("/issues/") ? "issue" : "link";
}

// What the list shows for a ref: owner/repo#N for GitHub PRs and issues, ~ for paths under home.
export function shortRef(ref: string, home: string): string {
  const gh = GITHUB.exec(ref);
  if (gh) return `${gh[1]}#${gh[2]}`;
  return isUrl(ref) ? ref : tildePath(ref, home);
}

// The list = add/done entries on the current branch replayed in order; an update keeps its slot.
export function replay(ctx: ExtensionContext): Artifact[] {
  const list = new Map<string, Artifact>();
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type !== "custom" || e.customType !== "artifact" || !e.data) continue;
    const { action, ...fields } = e.data as ArtifactEntry;
    if (action === "done") list.delete(fields.ref);
    else list.set(fields.ref, { ...list.get(fields.ref), ...fields });
  }
  return [...list.values()];
}

export default function artifacts(pi: ExtensionAPI) {
  const home = homedir();

  pi.registerTool({
    name: "artifact",
    label: "Artifact",
    description:
      "Register something you made that the user will want back — a PR or issue URL, a link, a .md report, a file — " +
      "so they can open it later from /artifacts. Call `add` when you create it (again to update title/note, e.g. " +
      "when a PR merges) and `done` when you are finished working with it. Kind is derived from the ref.",
    promptSnippet: "Register an artifact (URL or file) the user will want back; they open it from /artifacts",
    parameters: Type.Object({
      action: StringEnum(["add", "done"] as const, { description: "add: register or update; done: drop from the list" }),
      ref: Type.String({ description: "URL, or a file path (absolute, ~, or relative to cwd)" }),
      title: Type.Optional(Type.String({ description: "Short title shown next to the ref" })),
      note: Type.Optional(Type.String({ description: "Status or short note (merged, draft, …)" })),
    }),
    async execute(_id, { action, ref: raw, title, note }, _signal, _update, ctx) {
      const given = raw.trim().replace(/^@/, ""); // some models prefix paths with @
      const ref = isUrl(given) ? given : expandPath(given, home, ctx.cwd);
      const list = replay(ctx);
      const known = list.some((a) => a.ref === ref);
      const name = `${kindOf(ref)} ${shortRef(ref, home)}`;
      const text = (verb: string, n: number) =>
        `artifact: ${name} ${verb} (${n} in list)` + (n > NUDGE_AT ? ` — ${n} items; if these are project files they belong in a worktree` : "");
      if (action === "done") {
        if (!known) return { content: [{ type: "text", text: text("not in list", list.length) }], details: {} };
        pi.appendEntry<ArtifactEntry>("artifact", { action, ref });
        return { content: [{ type: "text", text: text("dropped", list.length - 1) }], details: {} };
      }
      pi.appendEntry<ArtifactEntry>("artifact", { action, ref, ...(title !== undefined && { title }), ...(note !== undefined && { note }) });
      return { content: [{ type: "text", text: text(known ? "updated" : "added", list.length + (known ? 0 : 1)) }], details: {} };
    },
  });

  async function open(a: Artifact, ctx: ExtensionContext) {
    if (kindOf(a.ref) === "doc") return viewMarkdown(pi, ctx, a.ref);
    const r = await pi.exec("open", [a.ref]);
    if (r.code !== 0) ctx.ui.notify(`artifacts: open ${shortRef(a.ref, home)}: ${r.stderr.trim() || `exit ${r.code}`}`, "error");
  }

  pi.registerCommand("artifacts", {
    description: "This session's artifacts (the `artifact` tool's list): Enter opens, d drops, esc closes",
    handler: async (_args, ctx) => {
      let cursor = 0;
      for (;;) {
        const list = replay(ctx);
        if (list.length === 0) return ctx.ui.notify("no artifacts registered in this session", "info");
        const titleWidth = Math.max(...list.map((a) => a.title?.length ?? 0));
        const rows = list.map((a) => ({
          value: a.ref,
          label: `${kindOf(a.ref).padEnd(5)} ${shortRef(a.ref, home)}`,
          description: `${(a.title ?? "").padEnd(titleWidth)}  ${a.note ?? ""}`.trimEnd(),
        }));
        const pick = await ctx.ui.custom<{ ref: string; drop?: true } | null>((tui, theme, _kb, done) => {
          const name = pi.getSessionName();
          const title = theme.fg("accent", theme.bold(name ? `artifacts · ${name}` : "artifacts"));
          const hint = theme.fg("dim", "↑↓ enter opens · d drops · esc");
          const view = new Container();
          view.addChild({
            render: (w: number) => [truncateToWidth(`${title}${" ".repeat(Math.max(1, w - visibleWidth(title) - visibleWidth(hint)))}${hint}`, w)],
            invalidate() {},
          });
          const select = new SelectList(rows, Math.min(rows.length, 10), {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          }, { minPrimaryColumnWidth: 1, maxPrimaryColumnWidth: 64 });
          select.setSelectedIndex(cursor);
          select.onSelect = (item) => done({ ref: item.value });
          select.onCancel = () => done(null);
          view.addChild(select);
          return {
            render: (w: number) => view.render(w),
            invalidate: () => view.invalidate(),
            handleInput(data: string) {
              const item = select.getSelectedItem();
              if (data === "d" && item) return done({ ref: item.value, drop: true });
              select.handleInput(data);
              tui.requestRender();
            },
          };
        });
        if (!pick) return;
        const item = list.find((a) => a.ref === pick.ref)!;
        if (!pick.drop) return open(item, ctx);
        cursor = list.indexOf(item); // SelectList clamps it if that was the last row
        pi.appendEntry<ArtifactEntry>("artifact", { action: "done", ref: pick.ref });
      }
    },
  });
}
