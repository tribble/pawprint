// herdr-fleet.ts — herdr-native fleet UX.
//   /fleet                  compact status surface: named agents + live state (deterministic, zero-token)
//   /delegate <name> <task> spawn a named herdr workspace running pi, hand it the task
//   /ws [purpose]           new focused workspace here, named from purpose/context (not the repo)
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

const NAME_RULE =
  "Name a coding-agent workspace: 2-4 short lowercase terms joined by hyphens describing the durable purpose of the work (e.g. fix-auth-refresh, ci-test-selection). Never the repository name. Reply with the name only.";

// Model-derived name, same quality bar as name_session. `hint` wins; otherwise the last few user
// messages of this session are the context.
async function suggestName(pi: ExtensionAPI, ctx: any, hint: string): Promise<string> {
  if (/^[a-z0-9][a-z0-9-]{1,40}$/.test(hint)) return hint; // already a slug: manual override
  let source = hint;
  if (!source) {
    const users = ctx.sessionManager
      .getBranch()
      .filter((e: any) => e.type === "message" && e.message?.role === "user")
      .slice(-3)
      .map((e: any) => (typeof e.message.content === "string" ? e.message.content : e.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")));
    source = users.join("\n---\n").slice(-4000);
  }
  if (!source.trim()) throw new Error("nothing to name from — /ws <purpose>");
  const model = ctx.model;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const r = await ctx.modelRegistry
    .getProvider(model.provider)
    .stream(
      model,
      { systemPrompt: NAME_RULE, messages: [{ role: "user", content: [{ type: "text", text: source }], timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, reasoning: "low" }
    )
    .result();
  if (r.stopReason === "error") throw new Error(r.errorMessage ?? "naming call failed");
  const text = r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const slug = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!slug) throw new Error(`model returned no usable name: ${JSON.stringify(text)}`);
  return slug;
}

async function uniqueLabel(pi: ExtensionAPI, name: string): Promise<string> {
  const res = (await herdr(pi, ["workspace", "list"])) as { workspaces?: { label?: string }[] };
  const taken = new Set((res.workspaces ?? []).map((w) => w.label));
  let label = name;
  for (let i = 2; taken.has(label); i++) label = `${name}-${i}`;
  return label;
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
        // --name makes session name = herdr name = intercom address (same contract as `ws create`).
        await herdr(pi, ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", "--name", name, "--thinking", "max"]);
        // herdr >=0.9 confirms text+Enter landed before reporting success (was a 5s settle hack on 0.8).
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

  pi.registerCommand("ws", {
    description:
      "New focused herdr workspace in this directory running pi, named from <purpose> (or this session's recent context): /ws [purpose]",
    handler: async (args, ctx) => {
      try {
        const name = await uniqueLabel(pi, await suggestName(pi, ctx, args.trim()));
        const ws = await herdr(pi, ["workspace", "create", "--cwd", process.cwd(), "--label", name]);
        const paneId = findPaneId(ws);
        if (!paneId) throw new Error("workspace created but no pane_id in response");
        await herdr(pi, ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", "--name", name]);
        ctx.ui.notify(`🐑 ${name} — workspace + pi ready (focused).`, "info");
      } catch (e) {
        ctx.ui.notify(`ws: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
