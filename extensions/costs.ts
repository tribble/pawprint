// costs.ts — /costs [days]: per-model cost of pi subagent runs, from the usage records in
// ~/.pi/agent/sessions/*/*/*/run-*/session.jsonl (one file = one run). Medians per model over
// runs: cost, assistant turns, total tokens, reasoning share, cache-read share; sorted by run
// count. The table is a TUI-only entry (pi.appendEntry + renderer), so it never enters the
// model's context; the agent_costs tool returns the same text for the model on request.
// Replaces the agent-costs script that used to live in agent/bin.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { globSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

// [cost $, turns, tokens, reasoning/tokens, cacheRead/tokens] per run
type Run = [number, number, number, number, number];

// One session.jsonl → its model (last assistant message's) and totals; null when no assistant turn.
function readRun(file: string): { model: string; run: Run } | null {
  let model = "?", cost = 0, turns = 0, tok = 0, reason = 0, cache = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let m: any;
    try { m = JSON.parse(line).message; } catch { continue; } // partial trailing line
    if (m?.role !== "assistant" || !m.usage) continue;
    turns++; cost += m.usage.cost?.total ?? 0; tok += m.usage.totalTokens ?? 0;
    reason += m.usage.reasoning ?? 0; cache += m.usage.cacheRead ?? 0; model = m.model ?? model;
  }
  // tok 0 (every turn errored before usage) → 0% shares instead of NaN
  return turns ? { model, run: [cost, turns, tok, tok ? reason / tok : 0, tok ? cache / tok : 0] } : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const pct = (x: number, w: number) => `${(x * 100).toFixed(1)}%`.padStart(w);

export function costsTable(sessionsDir: string, days?: number, now = Date.now()): string {
  const cutoff = days ? now - days * 86400_000 : 0;
  const by = new Map<string, Run[]>();
  for (const f of globSync(join(sessionsDir, "*/*/*/run-*/session.jsonl"))) {
    if (statSync(f).mtimeMs < cutoff) continue;
    const r = readRun(f);
    if (r) by.set(r.model, [...(by.get(r.model) ?? []), r.run]);
  }
  const head = `subagent runs, ${days ? `last ${days} days` : "all"}`;
  const cols = `${"model".padEnd(45)} ${"runs".padStart(4)} ${"med $".padStart(6)} ${"turns".padStart(5)} ${"Mtok".padStart(5)} ${"reason%".padStart(7)} ${"cache%".padStart(6)}`;
  const rows = [...by.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([model, rs]) => {
      const med = (i: number) => median(rs.map((r) => r[i]));
      return `${model.padEnd(45)} ${String(rs.length).padStart(4)} ${med(0).toFixed(2).padStart(6)} ${med(1).toFixed(0).padStart(5)} ${(med(2) / 1e6).toFixed(2).padStart(5)} ${pct(med(3), 7)} ${pct(med(4), 6)}`;
    });
  return [head, cols, ...rows].join("\n");
}

export default function costs(pi: ExtensionAPI) {
  const sessions = join(getAgentDir(), "sessions");

  pi.registerEntryRenderer<{ text: string }>("costs", (entry, _opts, theme) => new Text(theme.fg("muted", entry.data?.text ?? ""), 1, 1, (t) => theme.bg("customMessageBg", t)));

  pi.registerCommand("costs", {
    description: "Per-model cost of subagent runs (TUI only): /costs [days], default all",
    handler: async (args, ctx) => {
      const days = args.trim() ? Number(args.trim()) : undefined;
      if (days !== undefined && !(days > 0)) return ctx.ui.notify("usage: /costs [days]", "warning");
      pi.appendEntry("costs", { text: costsTable(sessions, days) });
    },
  });

  pi.registerTool({
    name: "agent_costs",
    label: "Agent costs",
    description: "Per-model cost of pi subagent runs on this machine (medians per run: $, turns, Mtok, reasoning%, cache%), sorted by run count.",
    promptSnippet: "Per-model cost table of subagent runs; days limits to recent runs",
    parameters: Type.Object({ days: Type.Optional(Type.Number({ description: "Only runs from the last N days (default: all)" })) }),
    async execute(_id, { days }) {
      return { content: [{ type: "text", text: costsTable(sessions, days) }], details: {} };
    },
  });
}
