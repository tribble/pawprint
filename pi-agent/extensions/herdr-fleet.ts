// herdr-fleet.ts — herdr-native fleet UX.
//   /fleet                  compact status surface: named agents + live state (deterministic, zero-token)
//   /delegate <name> <task> spawn a named herdr workspace running pi, hand it the task
//   /ws [repo|dir] <purpose> new focused workspace: dir from identifier or the model's read of the purpose; name from purpose
// Delegated pane agents are first-class: they join intercom under their herdr name,
// and you talk to them by focusing their pane (herdr agent focus <name>).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

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

// Explicit repo map, never scanned: ~/.pi/agent/configs/ws.json → {"repos": {"workos": "~/work/workos", ...}}
const wsConfigPath = () => `${process.env.HOME}/.pi/agent/configs/ws.json`;
function repoMap(): Record<string, string> {
  if (!existsSync(wsConfigPath())) return {};
  const raw = (JSON.parse(readFileSync(wsConfigPath(), "utf8")) as { repos?: Record<string, string> }).repos ?? {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")]));
}

const PLAN_RULE = (repos: string[]) =>
  `You plan a coding-agent workspace. Reply with JSON only: {"name": string, "repo": string|null}.
name: 2-4 short lowercase terms joined by hyphens describing the durable purpose of the work (e.g. fix-auth-refresh, ci-test-selection). Never a repository name.
repo: which of these repositories the work belongs to, or null if you cannot tell: ${repos.join(", ")}.`;

interface WsPlan { name: string; dir: string }

// Directory from an explicit identifier (path or configured repo id as first word) or, failing that,
// the session model's read of the purpose. Name is model-derived either way unless already a slug.
async function planWorkspace(pi: ExtensionAPI, ctx: any, args: string): Promise<WsPlan> {
  const [first = "", ...restWords] = args.split(/\s+/).filter(Boolean);
  let dir: string | undefined;
  let hint = args;
  const explicit = first.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
  const repos = repoMap();
  if (first && existsSync(explicit) && statSync(explicit).isDirectory()) dir = resolve(explicit);
  else if (first && repos[first]) dir = repos[first];
  if (dir) hint = restWords.join(" ");
  if (dir && /^[a-z0-9][a-z0-9-]{1,40}$/.test(hint)) return { name: hint, dir }; // slug + dir: no model call

  let source = hint;
  if (!source) {
    const users = ctx.sessionManager
      .getBranch()
      .filter((e: any) => e.type === "message" && e.message?.role === "user")
      .slice(-3)
      .map((e: any) => (typeof e.message.content === "string" ? e.message.content : e.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")));
    source = users.join("\n---\n").slice(-4000);
  }
  if (!source.trim()) throw new Error("nothing to plan from — /ws [repo|dir] <purpose>");
  const repoIds = Object.keys(repos);
  if (!dir && repoIds.length === 0) throw new Error(`no repos configured — add {"repos": {"<id>": "<path>"}} to ${wsConfigPath()} or /ws <dir> <purpose>`);
  const model = ctx.model;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const r = await ctx.modelRegistry
    .getProvider(model.provider)
    .stream(
      model,
      { systemPrompt: PLAN_RULE(repoIds), messages: [{ role: "user", content: [{ type: "text", text: source }], timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, reasoning: "low" }
    )
    .result();
  if (r.stopReason === "error") throw new Error(r.errorMessage ?? "planning call failed");
  const text = r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`model returned no plan: ${JSON.stringify(text)}`);
  const plan = JSON.parse(json) as { name?: string; repo?: string | null };
  const name = String(plan.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!name) throw new Error(`model returned no usable name: ${json}`);
  if (!dir) {
    if (!plan.repo || !repos[plan.repo]) throw new Error(`can't tell which repo — /ws <repo> ${hint}`);
    dir = repos[plan.repo];
  }
  return { name, dir };
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
      "New focused herdr workspace running pi: /ws [repo|dir] <purpose> — directory from the identifier or inferred from the purpose (repos listed in configs/ws.json); name from the purpose (or this session's recent context)",
    handler: async (args, ctx) => {
      try {
        const plan = await planWorkspace(pi, ctx, args.trim());
        const name = await uniqueLabel(pi, plan.name);
        const ws = await herdr(pi, ["workspace", "create", "--cwd", plan.dir, "--label", name]);
        const paneId = findPaneId(ws);
        if (!paneId) throw new Error("workspace created but no pane_id in response");
        await herdr(pi, ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", "--name", name]);
        ctx.ui.notify(`🐑 ${name} — pi ready in ${plan.dir.replace(process.env.HOME ?? "", "~")} (focused).`, "info");
      } catch (e) {
        ctx.ui.notify(`ws: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
