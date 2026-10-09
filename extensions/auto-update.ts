// auto-update.ts — updates run only when the user asks: /update (pi itself + all
// packages). session_start never installs, fetches, or locks.
// Applying extension updates is one `/reload` — or `/update` to do it all now.
// A pi self-update always applies on next launch (core code can't hot-swap).
//
// Third-party packages in settings.json are PINNED (`@<sha>` / `@<version>`), so
// `pi update --extensions` moves nothing but the floating pawprint clone. Moving
// a pin is a decision, so it is weekly and manual: session_start nags
// "weekly package review due — /packages" once 7 days have passed since the last
// /packages; `/packages` lists every package with what its pin is behind (git fetch
// per clone, `npm view` per npm package — read-only).
//
// Pawprint owns package membership and the exact third-party pins, and the source repo
// is the only place they change — both pi and the owner write the live settings.json,
// so a live edit always loses. `/packages bump|install|remove` therefore never touches
// the file or runs an installer: it queues the request into the active session
// (sendUserMessage, deliverAs followUp) as a source-worktree task — change
// agent/settings.json in a worktree, review, commit, then apply/install and verify.
// Queueing is REQUESTED only; the notice says queued, never done.
//
// One-off watch: Pi's bundled cloudflare-ai-gateway catalog spells Opus 5.5
// `claude-opus-5.5`, which the gateway 404s; agent/models.json carries a local
// `claude-opus-5-5` entry. Once Pi ships the dashed id, session_start says the
// workaround can go.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE = join(getAgentDir(), ".auto-update.json");
const REVIEW_MS = 7 * 24 * 60 * 60 * 1000; // weekly pin review

interface State {
  lastPackagesReview?: string;
}
function readState(): State {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}
function writeState(patch: State) {
  try {
    writeFileSync(STATE, JSON.stringify({ ...readState(), ...patch }));
  } catch { /* ignore */ }
}
const stale = (iso: string | undefined, ms: number) => !iso || Date.now() - Date.parse(iso) > ms;

// pi.exec resolves on timeout with killed=true (and code 0): a killed command never counts as done.
async function sh(pi: ExtensionAPI, cmd: string, args: string[], timeout: number) {
  const r = await pi.exec(cmd, args, { timeout });
  const ok = r.code === 0 && !r.killed;
  return { ok, out: r.stdout.trimEnd(), err: r.killed ? `timed out after ${timeout / 1000}s` : (r.stderr || r.stdout).trim() || `exit ${r.code}` };
}

interface UpdateResult {
  piUpdated: boolean;
  extChanged: boolean;
  failed: boolean;
}

async function runUpdates(pi: ExtensionAPI): Promise<UpdateResult> {
  let piUpdated = false;
  let extChanged = false;
  let failed = false;
  try {
    const self = await sh(pi, "pi", ["update", "--self"], 180_000);
    piUpdated = self.ok && !/already up to date/i.test(self.out);
    failed ||= !self.ok;
  } catch {
    failed = true; // offline etc.
  }
  try {
    const ext = await sh(pi, "pi", ["update", "--extensions", "--no-approve"], 300_000);
    extChanged = ext.ok && /^Updating /m.test(ext.out);
    failed ||= !ext.ok;
  } catch {
    failed = true;
  }
  return { piUpdated, extChanged, failed };
}

function summary({ piUpdated, extChanged }: UpdateResult): string {
  const parts: string[] = [];
  if (extChanged) parts.push("packages updated — /reload to apply");
  if (piUpdated) parts.push("pi updated — takes effect next launch");
  return parts.join("; ");
}

// ------------------------------------------------------------ /packages ---

// ponytail: one-off watch — delete this with the local claude-opus-5-5 entry in
// agent/models.json once Pi's bundled catalog ships the dashed id (the notice says
// so). The composed registry can't see through the models.json override, so this
// reads pi-ai's bundled catalog file from the running install: argv[1] is the
// cli.js node executes (shims exec it directly, bins are symlinks — realpath),
// and pi-ai sits under some ancestor's node_modules. Any failure — no argv[1],
// package gone, malformed JSON — is silent: never break startup.
function piShippedOpus55(): boolean {
  try {
    let dir = realpathSync(process.argv[1]);
    for (let prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
      const catalog = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data", "cloudflare-ai-gateway.json");
      if (!existsSync(catalog)) continue;
      const data: unknown = JSON.parse(readFileSync(catalog, "utf8"));
      return Object.values(data as Record<string, unknown>).some((api) =>
        Object.values(api as Record<string, { id?: unknown }>).some((m) => m.id === "claude-opus-5-5"),
      );
    }
  } catch { /* silent */ }
  return false;
}

export interface Pkg {
  index: number; // position in settings.packages
  source: string;
  kind: "git" | "npm" | "local";
  name: string; // git: owner/repo; npm: package name; local: the path
  ref?: string; // the pin (sha/tag/version); undefined = floating
  dir?: string; // git: the clone under <agentDir>/git/<host>/<path>
}

// Source forms per pi docs/packages.md: git:github.com/o/r[@ref], git:git@host:o/r,
// https:// ssh:// git:// URLs, npm:name[@version], and local paths.
export function parseSource(source: string, agentDir: string, index = 0): Pkg {
  if (source.startsWith("npm:")) {
    const m = /^(@?[^@]+)(?:@(.+))?$/.exec(source.slice(4))!;
    return { index, source, kind: "npm", name: m[1], ref: m[2] };
  }
  if (/^(git:|https?:\/\/|ssh:\/\/|git:\/\/)/.test(source)) {
    const u = source
      .replace(/^git:/, "")
      .replace(/^\w+:\/\//, "")
      .replace(/^git@/, "")
      .replace(/^([^/:]+):\d+\//, "$1/") // ssh port
      .replace(/^([^/:]+):/, "$1/"); // host:path shorthand
    const m = /^(.*?)(?:\.git)?(?:@(.+))?$/.exec(u)!; // after git@ is gone, the only @ starts the ref
    const [host, ...rest] = m[1].split("/");
    return { index, source, kind: "git", name: rest.join("/"), ref: m[2], dir: join(agentDir, "git", host, ...rest) };
  }
  return { index, source, kind: "local", name: source };
}

export function parsePackages(settings: { packages?: unknown[] }, agentDir: string): Pkg[] {
  return (settings.packages ?? []).map((p, i) =>
    parseSource(typeof p === "string" ? p : (p as { source: string }).source, agentDir, i),
  );
}

interface Latest {
  pinDate: string; // MM-DD of the pinned commit (git)
  behind: number; // commits pin..origin/HEAD (git); 0/1 for npm
  ref: string; // full sha / version to bump to
  line: string; // "<date> <subject>" (git) or "<version> available" (npm)
}

const short = (ref: string) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref);

// Read-only: fetches the clone (or asks the registry) and measures the pin against it.
// Throws on any failed command — a failed check must never read as "current".
async function latest(pi: ExtensionAPI, p: Pkg): Promise<Latest | undefined> {
  if (!p.ref) return undefined;
  const run = async (cmd: string, args: string[]) => {
    const r = await sh(pi, cmd, args, 60_000);
    if (!r.ok) throw new Error(`${cmd} ${args.filter((a) => !a.startsWith("-") && a !== p.dir).join(" ")}: ${r.err}`);
    return r.out;
  };
  if (p.kind === "npm") {
    const v = await run("npm", ["view", p.name, "version"]);
    if (!v) throw new Error(`npm view ${p.name}: no version`);
    return { pinDate: "", behind: v !== p.ref ? 1 : 0, ref: v, line: v !== p.ref ? `${v} available` : "" };
  }
  if (p.kind !== "git") return undefined;
  const git = (...args: string[]) => run("git", ["-C", p.dir!, ...args]);
  await git("fetch", "-q", "origin");
  if (!(await sh(pi, "git", ["-C", p.dir!, "rev-parse", "-q", "--verify", "origin/HEAD"], 60_000)).ok) await git("remote", "set-head", "origin", "-a");
  const ref = await git("rev-parse", "origin/HEAD");
  const behind = Number(await git("rev-list", "--count", `${p.ref}..origin/HEAD`));
  return {
    pinDate: await git("log", "-1", "--format=%ad", "--date=format:%m-%d", p.ref),
    behind,
    ref,
    line: behind ? await git("log", "-1", "--format=%ad %s", "--date=short", "origin/HEAD") : "",
  };
}

// Every package's check, run together; a failure is kept per package, not thrown.
const check = (pi: ExtensionAPI, pkgs: Pkg[]) =>
  Promise.all(pkgs.map(async (p) => {
    try {
      return [p, await latest(pi, p), undefined] as const;
    } catch (e) {
      return [p, undefined, e instanceof Error ? e.message : String(e)] as const;
    }
  }));

export function renderTable(rows: string[][]): string {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(w[c]))).join("  ").trimEnd()).join("\n");
}

const readSettings = (agentDir: string) => {
  const text = readFileSync(join(agentDir, "settings.json"), "utf8");
  return { text, settings: JSON.parse(text) as { packages: unknown[] } };
};

/** @returns true when every check succeeded (the review counts as done). */
async function listPackages(pi: ExtensionAPI, ctx: ExtensionContext, agentDir: string): Promise<boolean> {
  const pkgs = parsePackages(readSettings(agentDir).settings, agentDir);
  const rows = [["package", "pinned", "behind", "latest"]];
  let failed = 0;
  for (const [p, l, e] of await check(pi, pkgs)) {
    const pinned = p.kind === "npm" ? p.ref! : short(p.ref ?? "");
    if (e) { failed++; rows.push([p.name, pinned, "?", `check failed: ${e}`]); }
    else if (!l) rows.push([p.name, p.kind === "local" ? "local" : "floating", "—", ""]);
    else if (p.kind === "npm") rows.push([p.name, pinned, l.behind ? "" : "0", l.line]);
    else rows.push([p.name, `${pinned} ${l.pinDate}`, String(l.behind), l.line]);
  }
  ctx.ui.notify(renderTable(rows), failed ? "warning" : "info");
  return failed === 0;
}

export default function autoUpdate(pi: ExtensionAPI) {
  const agentDir = dirname(STATE);
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI && piShippedOpus55())
      ctx.ui.notify("Pi now ships the correct Opus 5.5 gateway ID — delete the local claude-opus-5-5 entry from agent/models.json (and this check)", "info");
    if (ctx.hasUI && stale(readState().lastPackagesReview, REVIEW_MS)) ctx.ui.notify("auto-update: weekly package review due — /packages", "info");
  });

  // The sanctioned reload path: command handlers get reload(); event handlers don't.
  pi.registerCommand("update", {
    description: "Update pi + all packages now, then reload to apply",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.notify("Updating pi + packages…", "info");
      const result = await runUpdates(pi);
      if (result.failed) ctx.ui.notify("auto-update: part of the update failed — run `pi update --all` in a shell to see why", "warning");
      const note = summary(result);
      if (result.extChanged) {
        ctx.ui.notify(note, "info");
        await ctx.reload();
      } else {
        ctx.ui.notify(note || "Everything up to date.", "info");
      }
    },
  });

  pi.registerCommand("packages", {
    description: "Pinned packages vs upstream; bump/install/remove queue the change as a source-repo task",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const [verb, what] = args.trim().split(/\s+/);
      if (!verb) {
        // A review counts only when every upstream check actually answered.
        if (await listPackages(pi, ctx, agentDir)) writeState({ lastPackagesReview: new Date().toISOString() });
        return;
      }
      if (!what || (verb !== "bump" && verb !== "install" && verb !== "remove")) {
        ctx.ui.notify("Usage: /packages | /packages bump <name|--all> | /packages install <source> | /packages remove <name>", "error");
        return;
      }
      // Membership/pins change only in the pawprint source repo — queue the request into
      // the active session; nothing here reads or writes settings.json or runs an installer.
      const command = `/packages ${args.trim()}`;
      await pi.sendUserMessage(
        `Owner outcome:\n${command}\n\n` +
        `The user ran \`${command}\` — a request to change pi's package membership/pins. Nothing has been changed yet; treat this as queued intent, not a result.\n` +
        "Pawprint owns the full package membership and the exact third-party pins (agent/settings.json in the source repo); the floating git:github.com/tribble/pawprint self entry is the approved exception.\n" +
        "Make the change through the normal source flow: a pawprint worktree, review, commit + merge; then apply/install so the live config dir matches, and independently verify both before reporting done.",
        { deliverAs: "followUp" },
      );
      ctx.ui.notify(`packages: queued \`${command}\` — nothing changed yet; the source workflow applies and verifies it`, "info");
    },
  });
}
