// md.ts — /md [path]: render a markdown file inline in the transcript, for the human.
// The agent says "Report updated at /tmp/x.md." — /md shows it right here instead of a
// `!!glow <paste>` round trip. No argument: the last .md path the agent named (newest
// assistant message first), so a bare /md after such a report opens it. `~` and paths
// relative to cwd are accepted. The file is stored as a custom entry (pi.appendEntry) and
// drawn by an entry renderer, so it is TUI-only: nothing here enters the model's context.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

interface MdEntry { path: string; text: string }

// Last local path ending in ".md": a `backticked` or "quoted" span (may contain spaces), else a
// bare token — quotes, brackets and `*` are excluded so (see ~/a.md) and **b.md** yield the bare
// path and a trailing . , : ) falls off via \b. x.md.bak is not a markdown file; URLs are what
// herdr already makes clickable, so they are skipped.
const MD_PATH = /`([^`\n]+\.md)`|"([^"\n]+\.md)"|[^\s`'"()<>[\]*]+\.md\b(?!\.\w)/g;

// The agent may backtick the whole `/md <path>` command; the path is what follows it. Any other
// space inside a span is the path's own (`/tmp/my report.md`).
const spanPath = (span: string) => span.replace(/^\/md\s+/, "");

export function lastMarkdownPath(text: string): string | null {
  const paths = [...text.matchAll(MD_PATH)].map((m) => (m[1] ?? m[2]) === undefined ? m[0] : spanPath(m[1] ?? m[2]!));
  return paths.filter((p) => !p.includes("://")).at(-1) ?? null;
}

export function expandPath(p: string, home: string, cwd: string): string {
  return resolve(cwd, p.replace(/^~(?=\/|$)/, home));
}

export function tildePath(abs: string, home: string): string {
  return abs === home || abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs;
}

// Read the file and append the TUI-only md-view entry (or notify why not). Also the doc opener for /artifacts.
export function viewMarkdown(pi: ExtensionAPI, ctx: ExtensionContext, raw: string): void {
  const home = homedir();
  const abs = expandPath(raw, home, ctx.cwd);
  const shown = tildePath(abs, home);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(abs)); // fatal: a binary is an error, not U+FFFD soup
    pi.appendEntry<MdEntry>("md-view", { path: shown, text });
  } catch (e) {
    ctx.ui.notify(`md: ${shown}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, "error");
  }
}

function lastMentioned(ctx: ExtensionCommandContext): string | null {
  const texts = ctx.sessionManager.getBranch().flatMap((e) =>
    e.type === "message" && e.message.role === "assistant"
      ? [e.message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n")]
      : [],
  );
  return texts.reverse().map(lastMarkdownPath).find((p) => p) ?? null;
}

export default function md(pi: ExtensionAPI) {
  pi.registerEntryRenderer<MdEntry>("md-view", (entry, _opts, theme) => {
    const { path = "", text = "" } = entry.data ?? {};
    const view = new Container();
    view.addChild(new Text(theme.fg("dim", `md · ${path}`), 1, 0));
    view.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
    return view;
  });

  pi.registerCommand("md", {
    description: "Render a markdown file inline (TUI only); no path = the last .md the agent named",
    handler: async (args, ctx) => {
      const raw = args.trim().replace(/^(["'])(.*)\1$/, "$2") || lastMentioned(ctx); // pi's file completion quotes paths with spaces
      if (!raw) return ctx.ui.notify("md: no .md path in the agent's messages", "warning");
      viewMarkdown(pi, ctx, raw);
    },
  });
}
