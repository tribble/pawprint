// auto-update.ts — daily background self-update: pi itself + all packages.
// Every session_start also refreshes the floating package this file runs from
// (pi's startup banner nags while that clone lags origin): silent unless the
// clone moved, then "pawprint updated — /reload to apply".
// session_start: updates silently, notifies only. Reload on event-context is
// deliberately not exposed by pi ("safe only in user-initiated commands"), so
// applying extension updates is one `/reload` — or `/update` to do it all now.
// A pi self-update always applies on next launch (core code can't hot-swap).
// Several sessions starting together (herdr): a mkdir lock means only one runs it.
//
// pi stamps `lastChangelogVersion` into settings.json on every upgrade. When that is the
// only change in the config repo (validate.sh's check: one such key, same bytes once the
// version is masked, same mode), session_start commits it as `pi <ver> stamp` and pushes —
// silently. Anything else dirty, or any failure (offline, a save landing mid-check, a
// rejected push): no-op, the next start retries; a stamp that committed but did not push
// is pushed then.
//
// Third-party packages in settings.json are PINNED (`@<sha>` / `@<version>`), so the
// daily `pi update --extensions` moves nothing but the floating pawprint clone. Moving
// a pin is a decision, so it is weekly and manual: session_start nags
// "weekly package review due — /packages" once 7 days have passed since the last
// /packages; `/packages` lists every package with what its pin is behind (git fetch
// per clone, `npm view` per npm package — read-only); `/packages bump <name>` and
// `/packages bump --all` rewrite the pin in settings.json (the JSON string in place —
// never `pi install`, which rewrites object-form entries), run
// `pi update --extensions` to reconcile the clone, and commit + push the config repo
// (dirname of the agent dir, tribble's ~/.pi worktree). A dirty worktree aborts first.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = join(getAgentDir(), ".auto-update.json");
const LOCK = STATE + ".lock";
const TTL_MS = 20 * 60 * 60 * 1000; // ~daily
const REVIEW_MS = 7 * 24 * 60 * 60 * 1000; // weekly pin review

interface State {
  lastRun?: string;
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

// This package's own clone: the repo this file runs from when pi loads the package
// (<agentDir>/git/<host>/<owner>/<repo>/extensions/auto-update.ts). Its settings
// entry is the floating git package (no @ref) whose clone dir is that repo root.
// realpath both sides: node resolves symlinks in import.meta.url (/var → /private/var).
const SELF_REPO = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

// Every session start: `pi update --extension <own floating source>` so the clone never
// lags origin (pi's async banner check compares them). Silent on any failure; pi prints
// "Updating <source>" for git packages whether or not anything changed, so only a HEAD
// move counts as an update. Runs under the same mkdir lock as the daily update.
async function refreshSelf(pi: ExtensionAPI, ctx: ExtensionContext, agentDir: string) {
  try {
    const self = parsePackages(readSettings(agentDir).settings, agentDir).find((p) => p.kind === "git" && !p.ref && p.dir && real(p.dir) === SELF_REPO);
    if (!self) return;
    const head = async () => (await sh(pi, "git", ["-C", self.dir!, "rev-parse", "HEAD"], 30_000)).out;
    const before = await head();
    await sh(pi, "pi", ["update", "--extension", self.source, "--no-approve"], 120_000);
    if (before && before !== (await head()) && ctx.hasUI) ctx.ui.notify(`${self.name.split("/").pop()} updated — /reload to apply`, "info");
  } catch { /* no settings.json, offline, reload mid-exec — next start retries */ }
}

const STAMP = /^( *"lastChangelogVersion": *")([^"]*)"/gm;

async function commitStamp(pi: ExtensionAPI, agentDir: string) {
  const root = dirname(agentDir);
  const file = join(agentDir, "settings.json");
  const rel = relative(root, file);
  const git = (...args: string[]) => sh(pi, "git", ["-C", root, ...args], 30_000);
  const status = await git("status", "--porcelain");
  if (!status.ok) return;
  if (status.out === ` M ${rel}`) {
    let now: string;
    try { now = readFileSync(file, "utf8"); } catch { return; }
    const stamps = [...now.matchAll(STAMP)];
    if (stamps.length !== 1) return;
    const mode = await git("-c", "core.fileMode=true", "diff", "--no-color", "--", rel);
    if (!mode.ok || /^old mode/m.test(mode.out)) return;
    const head = await pi.exec("git", ["-C", root, "show", `HEAD:${rel}`], { timeout: 30_000 }); // raw bytes: sh() trims
    const mask = (s: string) => s.replace(STAMP, '$1X"');
    if (head.code !== 0 || head.killed || mask(head.stdout) !== mask(now)) return;
    // ponytail: a save landing between this re-read and the commit rides along; git has no CAS for a pathspec commit
    if (readFileSync(file, "utf8") !== now) return;
    if (!(await git("commit", "-q", "-m", `pi ${stamps[0][2]} stamp`, "--", rel)).ok) return;
  } else if (status.out !== "") return;
  const unpushed = await git("log", "--format=%s", "@{u}..HEAD");
  if (unpushed.ok && unpushed.out && unpushed.out.split("\n").every((s) => /^pi \S+ stamp$/.test(s))) await git("push", "-q");
}

// ------------------------------------------------------------ /packages ---

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

// Rewrites the @ref suffix of the matching source (string or object-form .source) in place.
export function bumpSource(settings: { packages: unknown[] }, p: Pkg, ref: string) {
  const src = p.source.slice(0, p.source.length - p.ref!.length) + ref;
  const entry = settings.packages[p.index];
  if (typeof entry === "string") settings.packages[p.index] = src;
  else (entry as { source: string }).source = src;
}

/** @returns true when the bump (or "current") completed with every check verified. */
async function bumpPackages(pi: ExtensionAPI, ctx: ExtensionContext, agentDir: string, which: string): Promise<boolean> {
  const root = dirname(agentDir);
  const err = (msg: string) => { ctx.ui.notify(`packages: ${msg}`, "error"); return false; };
  // Other uncommitted config changes must not ride along in the bump commit.
  const clean = async () => {
    const status = await sh(pi, "git", ["-C", root, "status", "--porcelain"], 30_000);
    if (!status.ok) return err(`git status in ${root} failed: ${status.err}`);
    const dirty = status.out.split("\n").filter((l) => l && !l.startsWith("??"));
    return dirty.length ? err(`${root} has uncommitted changes — commit or drop them first: ${dirty.map((l) => l.slice(3)).join(", ")}`) : true;
  };
  if (!(await clean())) return false;

  const pkgs = parsePackages(readSettings(agentDir).settings, agentDir);
  const all = which === "--all";
  const targets = all ? pkgs.filter((p) => p.ref) : pkgs.filter((p) => p.name === which || p.name.endsWith("/" + which));
  if (!targets.length) return err(all ? "nothing is pinned" : `no package named ${which} in settings.json`);
  if (!all && !targets[0].ref) return err(`${which} is floating — nothing to bump`);

  const results = await check(pi, targets);
  const failures = results.filter(([, , e]) => e).map(([p, , e]) => `${p.name}: ${e}`);
  if (failures.length) return err(`check failed, nothing bumped — ${failures.join("; ")}`);

  // The checks took a while: re-read the file and re-check the worktree so a pin edit is
  // the only change written, applied to whatever settings.json holds now.
  if (!(await clean())) return false;
  const { text, settings } = readSettings(agentDir);
  const now = parsePackages(settings, agentDir);
  const bumped: string[] = [];
  const npmBumps: [Pkg, Latest][] = [];
  for (const [p, l] of results) {
    if (!l?.behind) continue;
    const cur = now.find((q) => q.source === p.source);
    if (!cur) continue; // changed underneath us: leave it alone
    bumped.push(all ? p.name.split("/").pop()! : `${p.name.split("/").pop()} ${short(p.ref!)}→${short(l.ref)}`);
    bumpSource(settings, cur, l.ref);
    if (p.kind === "npm") npmBumps.push([p, l]);
  }
  if (!bumped.length) { ctx.ui.notify(all ? "all current" : `${which} is current`, "info"); return true; }
  const file = join(agentDir, "settings.json");
  const written = JSON.stringify(settings, null, 2) + (text.endsWith("\n") ? "\n" : "");
  writeFileSync(file, written);

  // Install before publishing. `pi update --extensions` moves git clones to their pins but
  // skips exact npm pins (pi installs those on the next /reload) — so npm bumps are installed
  // here the way pi would, into <agentDir>/npm, and verified, so a failure is bump's to handle.
  const reconcile = () => sh(pi, "pi", ["update", "--extensions", "--no-approve"], 300_000);
  const apply = async (): Promise<string | undefined> => {
    const upd = await reconcile();
    if (!upd.ok) return `pi update --extensions failed: ${upd.err}`;
    for (const [p, l] of npmBumps) {
      const npmRoot = join(agentDir, "npm");
      const r = await sh(pi, "npm", ["install", `${p.name}@${l.ref}`, "--prefix", npmRoot, "--legacy-peer-deps"], 300_000);
      if (!r.ok) return `npm install ${p.name}@${l.ref} failed: ${r.err}`;
      let got: string | undefined;
      try { got = JSON.parse(readFileSync(join(npmRoot, "node_modules", p.name, "package.json"), "utf8")).version; } catch { /* missing */ }
      if (got !== l.ref) return `npm install ${p.name}@${l.ref} left ${got ?? "nothing"} installed`;
    }
  };
  // Installing can take minutes; another pane may save settings meanwhile. Only the bytes
  // this bump wrote are ever rolled back or committed — anything else is left for the owner.
  const untouched = () => readFileSync(file, "utf8") === written;
  const failure = await apply();
  if (failure) {
    if (!untouched()) return err(`${failure}; ${file} changed meanwhile — sort it out by hand: git -C ${root} diff`);
    writeFileSync(file, text);
    // clones follow the pins back; a stale npm install is re-pinned by pi itself on /reload
    const back = await reconcile();
    return err(back.ok ? `${failure} — pins restored, clones reconciled` : `${failure} — pins restored, but clones may still sit at the new ref: pi update --extensions`);
  }
  if (!untouched()) return err(`${file} changed while packages installed — installed, nothing committed: git -C ${root} add -p ${relative(root, file)}`);
  const msg = all ? `packages: bump ${bumped.length} (${bumped.join(", ")})` : `packages: bump ${bumped[0]}`;
  const commit = await sh(pi, "git", ["-C", root, "commit", "-m", msg, "--", relative(root, file)], 120_000);
  if (!commit.ok) return err(`git commit failed (pins written to ${file}, packages installed): ${commit.err}`);
  const push = await sh(pi, "git", ["-C", root, "push"], 120_000);
  if (!push.ok) return err(`committed but git push failed — run: git -C ${root} push — ${push.err}`);
  ctx.ui.notify(all ? `bumped ${bumped.length} — /reload to load them` : `bumped ${bumped[0]} — /reload to load it`, "info");
  return true;
}

export default function autoUpdate(pi: ExtensionAPI) {
  const agentDir = dirname(STATE);
  pi.on("session_start", (_event, ctx) => {
    const st = readState();
    if (ctx.hasUI && stale(st.lastPackagesReview, REVIEW_MS)) ctx.ui.notify("auto-update: weekly package review due — /packages", "info");
    const due = stale(st.lastRun, TTL_MS);

    // Multiple panes launch together (herdr) — only one session stamps/updates.
    try {
      mkdirSync(LOCK);
    } catch {
      return;
    }

    void (async () => {
      try {
        try { await commitStamp(pi, agentDir); } catch { /* reload mid-check invalidates pi.exec; next start retries */ }
        await refreshSelf(pi, ctx, agentDir);
        if (!due) return;
        const result = await runUpdates(pi);
        writeState({ lastRun: new Date().toISOString() });
        const note = summary(result);
        if (ctx.hasUI && note) ctx.ui.notify(`auto-update: ${note}`, "info");
      } finally {
        rmSync(LOCK, { recursive: true, force: true });
      }
    })();
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
    description: "Pinned packages vs upstream; `bump <name>` / `bump --all` moves pins, commits, pushes",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const [verb, what] = args.trim().split(/\s+/);
      let reviewed = false;
      if (!verb) reviewed = await listPackages(pi, ctx, agentDir);
      else if (verb === "bump" && what) reviewed = await bumpPackages(pi, ctx, agentDir, what);
      else ctx.ui.notify("Usage: /packages | /packages bump <name> | /packages bump --all", "error");
      // A review counts only when every upstream check actually answered.
      if (reviewed) writeState({ lastPackagesReview: new Date().toISOString() });
    },
  });
}
