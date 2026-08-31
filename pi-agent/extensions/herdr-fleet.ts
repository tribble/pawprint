// herdr-fleet.ts — herdr-native fleet UX.
//   /fleet                  compact status surface: named agents + live state (deterministic, zero-token)
//   /delegate <name> <task> spawn a named herdr workspace running pi, hand it the task
// Delegated pane agents are first-class: they join intercom under their herdr name,
// and you talk to them by focusing their pane (herdr agent focus <name>).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function herdr(pi: ExtensionAPI, args: string[]): Promise<unknown> {
  const r = await pi.exec("herdr", args);
  if (r.code !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return (JSON.parse(r.stdout) as { result: unknown }).result;
}

function findPaneId(x: unknown): string | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.pane_id === "string") return o.pane_id;
  for (const v of Object.values(o)) {
    const hit = findPaneId(v);
    if (hit) return hit;
  }
  return null;
}

const ICON: Record<string, string> = { working: "⚙", idle: "○", done: "✓" };
const RANK: Record<string, number> = { working: 0, idle: 1, done: 2 };

interface FleetAgent {
  name?: string;
  cwd?: string;
  pane_id?: string;
  focused?: boolean;
  agent_status?: string;
}

export default function herdrFleet(pi: ExtensionAPI) {
  pi.registerCommand("fleet", {
    description: "Fleet status surface: herdr agents with live state",
    handler: async (_args, ctx) => {
      try {
        const res = (await herdr(pi, ["agent", "list"])) as { agents?: FleetAgent[] };
        const agents = res.agents ?? [];
        if (agents.length === 0) {
          ctx.ui.notify("No herdr agents found.", "info");
          return;
        }
        agents.sort(
          (a, b) => (RANK[a.agent_status ?? ""] ?? 3) - (RANK[b.agent_status ?? ""] ?? 3)
        );
        const lines = agents.map((a) => {
          const name = a.name ?? a.cwd?.split("/").pop() ?? a.pane_id ?? "?";
          const cwd = (a.cwd ?? "").replace(process.env.HOME ?? "", "~");
          return `${a.focused ? "→" : " "} ${ICON[a.agent_status ?? ""] ?? "?"} ${name}  ${cwd}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (e) {
        ctx.ui.notify(`fleet: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("delegate", {
    description:
      "Spawn a named herdr workspace running pi and hand it a task: /delegate <name> <task> (runs in the current directory — use a worktree yourself if it edits code)",
    handler: async (args, ctx) => {
      const sp = args.indexOf(" ");
      const name = (sp === -1 ? args : args.slice(0, sp)).trim();
      const task = sp === -1 ? "" : args.slice(sp + 1).trim();
      if (!name || !task) {
        ctx.ui.notify("Usage: /delegate <name> <task>", "error");
        return;
      }
      try {
        ctx.ui.notify(`Spawning ${name}…`, "info");
        const ws = await herdr(pi, ["workspace", "create", "--cwd", process.cwd(), "--label", name]);
        const paneId = findPaneId(ws);
        if (!paneId) throw new Error("workspace created but no pane_id in response");
        await herdr(pi, ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000"]);
        // herdr's readiness fires before pi's TUI accepts input; prompts sent earlier vanish.
        // ponytail: fixed settle delay, revisit as a readiness probe only if 5s proves flaky.
        await new Promise((r) => setTimeout(r, 5000));
        await herdr(pi, ["agent", "prompt", name, task, "--wait"]);
        ctx.ui.notify(
          `🐑 ${name} delegated — \`herdr agent focus ${name}\` to watch; it can reach this session via intercom.`,
          "info"
        );
      } catch (e) {
        ctx.ui.notify(`delegate: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
