// Recorded-descendant accounting only. Never open a foreign SessionManager or reprice history.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

type Json = Record<string, unknown>;
type Flag = "missing" | "unpriced" | "unknown" | "incomplete" | "unsupported" | "in-flight" | "activity-unknown" | "not-started";
interface Contribution { id: string; usage: Json; provider?: string; model?: string }
interface Journal { file: string; header: Json; entries: Json[]; issues: string[] }
interface Node {
  id: string; label: string; kind: "root" | "pane" | "headless"; role?: string; file?: string; pane?: string; owner?: Node;
  raw: string[]; children: Node[]; flags: Set<Flag>; issues: string[]; runs: { id: string; state: string }[];
  own: number | null; subtree: number | null; activity?: string; activityAllowed?: boolean;
}
export interface WorkstreamReport {
  root: string; observedAt: string; total: number | null; contributions: number; flags: Flag[];
  nodes: { id: string; label: string; kind: string; depth: number; own: number | null; subtree: number | null; activity?: string; flags: Flag[]; issues: string[]; runs: { id: string; state: string }[] }[];
  text: string;
}
const obj = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(obj) : [];
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const runId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const nativeFilename = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([a-zA-Z0-9_-]+)\.jsonl$/;
const label = (value: unknown, fallback: string): string => str(value)?.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").slice(0, 80) || fallback;
const inside = (root: string, file: string): boolean => { const r = relative(root, file); return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const numbers = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const prices = ["input", "output", "cacheRead", "cacheWrite", "total"];
const pick = (v: Json, keys: string[]): Json => Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const validUsage = (u: Json): boolean => numbers.every(k => finite(u[k])) && prices.every(k => finite(obj(u.cost)[k]));
const dollars = (u: Json): number => obj(u.cost).total as number;
const money = (n: number | null) => n === null ? "unknown" : `$${n.toFixed(2)}`;
const definitions: Record<Flag, string> = {
  missing: "usage or source unavailable", unpriced: "positive tokens with zero recorded rates; historical price unknown",
  unknown: "outcome or ownership unresolved", incomplete: "recorded coverage incomplete", unsupported: "unsupported source version",
  "in-flight": "recorded usage so far; work running", "activity-unknown": "pane activity unavailable", "not-started": "failed before pane start",
};

function usage(value: unknown): Json {
  const u = obj(value), cost = obj(u.cost);
  return {
    ...Object.fromEntries([...numbers, "reasoning", "cacheWrite1h"].filter(k => typeof u[k] === "number").map(k => [k, u[k]])),
    cost: Object.fromEntries(prices.filter(k => typeof cost[k] === "number").map(k => [k, cost[k]])),
  };
}

// Discard transcript/task/error contents immediately after parsing each record.
function project(e: Json): Json {
  const m = obj(e.message), details = obj(m.details);
  const out = pick(e, ["type", "id", "version", "cwd", "parentSession", "checkpoint", "provider", "model", "contributionId", "customType"]);
  if (e.usage !== undefined) out.usage = usage(e.usage);
  if (e.message) out.message = {
    ...pick(m, ["role", "provider", "model", "responseModel", "stopReason"]),
    ...(m.usage !== undefined ? { usage: usage(m.usage) } : {}),
    ...(obj(details.parentUsage).contributions !== undefined ? { contributions: list(obj(details.parentUsage).contributions).map(c => ({ ...pick(c, ["id", "provider", "model"]), usage: usage(c.usage) })) } : {}),
  };
  if (e.customType === "fleet-launch") out.data = pick(obj(e.data), ["ownerSessionId", "ownerSessionFile", "childSessionId", "launchId", "name", "role", "phase", "cwd", "paneId"]);
  if (e.customType === "subagent-run") out.data = { ...pick(obj(e.data), ["ownerSessionId", "runId", "legacy"]), children: list(obj(e.data).children).map(c => pick(c, ["agent", "sessionFile"])) };
  return out;
}

export async function workstreamCosts(pi: ExtensionAPI, ctx: ExtensionContext, sessions: string, full = false, signal?: AbortSignal): Promise<WorkstreamReport> {
  signal?.throwIfAborted();
  const rootId = ctx.sessionManager.getSessionId();
  if (!safeId(rootId)) throw new Error("Workstream costs needs a native calling-session identity");
  const cache = new Map<string, Journal>(), nodes: Node[] = [], visited = new Map<string, Node>(), nativeIds = new Map<string, string>();
  const contributions = new Map<string, Contribution>(), folds = new Map<string, string[]>(), conflicts = new Set<string>();
  let sessionRoot: string;
  try { sessionRoot = realpathSync(sessions); } catch { sessionRoot = resolve(sessions); }
  const issue = (node: Node, message: string, flag: Flag = "incomplete") => { node.flags.add(flag); node.issues.push(message); };
  const node = (id: string, text: string, kind: Node["kind"]): Node => {
    const n: Node = { id, label: text, kind, raw: [], children: [], flags: new Set(), issues: [], runs: [], own: null, subtree: null };
    nodes.push(n); return n;
  };
  const canonical = (file: string) => { try { return realpathSync(file); } catch { return resolve(file); } };
  // Check lexical shape and symlink confinement BEFORE opening, then inode/regular-file identity before reading.
  function read(file: string, allowed: string): string {
    signal?.throwIfAborted();
    if (!isAbsolute(file) || file !== resolve(file) || /\p{C}/u.test(file) || !inside(sessionRoot, file) || !inside(allowed, file)) throw new Error("denied source path");
    let target: string;
    try { target = realpathSync(file); } catch { throw new Error("source unavailable"); }
    if (!inside(sessionRoot, target) || !inside(canonical(allowed), target)) throw new Error("denied source path");
    const before = statSync(target);
    if (!before.isFile()) throw new Error("denied non-file source");
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const after = fstatSync(fd);
      if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev) throw new Error("source changed during read");
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  }
  function journal(file: string, allowed = sessionRoot): Journal {
    if (!isAbsolute(file) || file !== resolve(file) || /\p{C}/u.test(file) || !inside(sessionRoot, file) || !inside(allowed, file)) throw new Error("denied source path");
    const key = canonical(file);
    // Revalidate even cached paths against this edge's allowed directory.
    if (!inside(allowed, file) || !inside(canonical(allowed), key)) throw new Error("denied source path");
    const cached = cache.get(key);
    if (cached) return cached;
    if (!(basename(file) === "session.jsonl" || nativeFilename.test(basename(file)))) throw new Error("invalid source filename");
    const text = read(file, allowed), lines = text.split("\n"), entries: Json[] = [], issues: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const parsed: unknown = JSON.parse(lines[i]);
        if (Object.keys(obj(parsed)).length === 0) throw new Error("invalid record");
        entries.push(project(obj(parsed)));
      } catch (error) {
        // V8's EOF/position distinguishes incomplete publication. Never expose its source-bearing message.
        const diagnostic = error instanceof SyntaxError ? error.message : "";
        const position = diagnostic.match(/at position (\d+)/)?.[1];
        const atEnd = diagnostic === "Unexpected end of JSON input" || position !== undefined && Number(position) === lines[i].length;
        if (i === lines.length - 1 && /^\s*\{/.test(lines[i]) && atEnd) continue;
        issues.push(`${basename(file)}: invalid JSONL at line ${i + 1}`);
        if (i === 0) break;
      }
    }
    const header = entries.shift() ?? {};
    const j = { file: key, header, entries, issues }; cache.set(key, j); return j;
  }
  function metadata(dir: string, name: string, n: Node): Json | undefined {
    try {
      const value = obj(JSON.parse(read(join(dir, name), dir)));
      return {
        ...pick(value, ["id", "runId", "recordVersion", "runtimeVersion", "sessionId", "sessionFile", "state"]),
        steps: list(value.steps).map(c => pick(c, ["agent", "sessionFile"])),
        results: list(value.results).map(c => ({ ...pick(c, ["agent", "sessionFile", "nativeSessionId"]), accounting: pick(obj(c.accounting), ["state"]) })),
      };
    }
    catch (e) {
      const message = e instanceof Error ? e.message : "source unavailable";
      if (message === "source unavailable") return;
      issue(n, message.startsWith("denied") ? message : `invalid ${name}`); return;
    }
  }
  function register(c: Contribution, n: Node) {
    const previous = contributions.get(c.id);
    if (previous && (!isDeepStrictEqual(previous.usage, c.usage) || previous.provider && c.provider && previous.provider !== c.provider || previous.model && c.model && previous.model !== c.model)) {
      conflicts.add(c.id); issue(n, "conflicting usage provenance"); return;
    }
    contributions.set(c.id, { ...previous, ...c, provider: c.provider ?? previous?.provider, model: c.model ?? previous?.model });
    if (dollars(c.usage) === 0 && (c.usage.totalTokens as number) > 0) n.flags.add("unpriced");
    if (c.usage.totalTokens === 0) n.flags.add("unknown");
  }
  function part(value: Json, n: Node): Contribution | undefined {
    const cid = str(value.id), pieces = cid?.split(":");
    if (!pieces || pieces.length !== 2 || !safeId(pieces[0]) || !safeId(pieces[1]) || !validUsage(obj(value.usage))) { issue(n, "invalid folded provenance"); return; }
    return { id: cid!, usage: obj(value.usage), provider: str(value.provider), model: str(value.model) };
  }
  function inherited(j: Journal, n: Node, chain = new Set<string>()): Set<string> | undefined {
    if (!j.header.parentSession) return new Set();
    const path = str(j.header.parentSession);
    if (!path || chain.has(path)) { issue(n, "invalid fork provenance"); return; }
    try {
      const parent = journal(path);
      if (parent.header.type !== "session" || parent.header.version !== 3 || !safeId(parent.header.id) || parent.issues.length) {
        issue(n, "unsupported or invalid fork parent", parent.header.version !== 3 ? "unsupported" : "incomplete"); return;
      }
      if (!inherited(parent, n, new Set([...chain, path]))) return;
      return new Set(parent.entries.map(e => str(e.id)).filter((v): v is string => !!v));
    } catch { issue(n, "fork parent unavailable", "missing"); return; }
  }
  function account(j: Journal, n: Node, excluded: Set<string>) {
    for (const e of j.entries) {
      if (excluded.has(str(e.id) ?? "") || e.checkpoint === true) continue;
      const m = obj(e.message), required = e.type === "usage" || m.role === "assistant";
      const value = e.type === "message" && ["assistant", "toolResult"].includes(str(m.role) ?? "") ? m.usage : ["usage", "compaction", "branch_summary"].includes(str(e.type) ?? "") ? e.usage : undefined;
      if (!value) { if (required) issue(n, "usage unavailable", "missing"); continue; }
      if (!safeId(e.id) || !validUsage(obj(value))) { issue(n, "invalid usage", "missing"); continue; }
      const c: Contribution = { id: `${n.id}:${e.id}`, usage: obj(value), provider: str(m.provider ?? e.provider), model: str(m.responseModel ?? m.model ?? e.model) };
      register(c, n); n.raw.push(c.id);
      if (m.role === "toolResult" && m.contributions !== undefined) {
        const parts = list(m.contributions).map(p => part(p, n));
        const unique = new Map(parts.filter((p): p is Contribution => !!p).map(p => [p.id, p]));
        const cs = [...unique.values()];
        const matches = parts.length > 0 && parts.every(Boolean) && numbers.every(k => Math.abs(cs.reduce((v, p) => v + (p.usage[k] as number), 0) - (c.usage[k] as number)) < 1e-8) && prices.every(k => Math.abs(cs.reduce((v, p) => v + (obj(p.usage.cost)[k] as number), 0) - (obj(c.usage.cost)[k] as number)) < 1e-8);
        if (!matches) { conflicts.add(c.id); issue(n, "folded aggregate mismatch"); continue; }
        for (const p of parts) if (p) register(p, n);
        const refs = cs.map(p => p.id), previous = folds.get(c.id);
        if (previous && !isDeepStrictEqual(previous, refs)) { conflicts.add(c.id); issue(n, "conflicting folded provenance"); }
        folds.set(c.id, refs);
      } else if (str(e.contributionId)?.startsWith("subagent:")) {
        const p = part({ ...c, id: (e.contributionId as string).slice(9) }, n);
        if (p) { register(p, n); folds.set(c.id, [p.id]); }
        else conflicts.add(c.id);
      }
    }
  }
  function paneFile(child: string): string | undefined {
    const found: string[] = [];
    try {
      for (const dir of readdirSync(sessions, { withFileTypes: true })) {
        if (!dir.isDirectory() || !/^--[^/\\\p{C}]+--$/u.test(dir.name)) continue;
        const folder = join(sessions, dir.name);
        if (!inside(sessionRoot, realpathSync(folder))) continue;
        for (const name of readdirSync(folder)) if (name.endsWith(`_${child}.jsonl`)) found.push(join(folder, name));
      }
    } catch { throw new Error("pane sources unavailable"); }
    if (found.length > 1) throw new Error("ambiguous native child identity");
    return found[0];
  }
  function walk(j: Journal, n: Node) {
    signal?.throwIfAborted();
    for (const error of j.issues) issue(n, error);
    if (j.header.type !== "session" || j.header.id !== n.id || !safeId(j.header.id)) { issue(n, "native identity mismatch"); return; }
    if (j.header.version !== 3) { issue(n, "unsupported session version", "unsupported"); return; }
    if (nativeIds.has(n.id) && nativeIds.get(n.id) !== j.file) { issue(n, "duplicate native identity across sources"); return; }
    nativeIds.set(n.id, j.file);
    n.file = j.file; visited.set(j.file, n);
    const excluded = inherited(j, n);
    if (!excluded) return;
    account(j, n, excluded);
    const panes = new Map<string, Json>(), runs = new Map<string, Json>();
    for (const e of j.entries) {
      if (excluded.has(str(e.id) ?? "")) continue;
      const r = obj(e.data);
      if (e.customType !== "fleet-launch" && e.customType !== "subagent-run") continue;
      if (r.ownerSessionId !== n.id) continue; // Proven foreign/fork-inherited records are not this node's edges.
      if (e.customType === "fleet-launch") panes.set(str(r.launchId) ?? `invalid-${panes.size}`, r);
      else runs.set(str(r.runId) ?? `invalid-${runs.size}`, r);
    }
    for (const r of panes.values()) {
      const child = node(safeId(r.childSessionId) ? r.childSessionId : "invalid-child", `${r.role === "coordinator" ? "Coordinator" : "Coder"} ${label(r.name, "unnamed")}`, "pane");
      n.children.push(child); child.role = str(r.role); child.pane = str(r.paneId);
      if (!runId(r.launchId) || !safeId(r.childSessionId) || r.ownerSessionFile !== j.file || !["coder", "coordinator"].includes(str(r.role) ?? "") || !isAbsolute(str(r.cwd) ?? "")) { issue(child, "pane ownership/path mismatch"); child.flags.add("unknown"); continue; }
      if (r.phase === "failed-before-pane" || r.phase === "released") { child.flags.add("not-started"); continue; }
      try {
        const path = paneFile(r.childSessionId);
        if (!path) { child.activityAllowed = true; issue(child, "native child source unavailable", "missing"); continue; }
        const cj = journal(path);
        if (!isAbsolute(str(cj.header.cwd) ?? "") || resolve(cj.header.cwd as string) !== resolve(r.cwd as string)) { issue(child, "native child cwd mismatch"); continue; }
        if (visited.has(cj.file)) { issue(child, "duplicate or cyclic ownership edge"); continue; }
        walk(cj, child); child.activityAllowed = child.file !== undefined;
      } catch (e) { issue(child, e instanceof Error && /^(denied|invalid source|ambiguous)/.test(e.message) ? e.message : "native child source unavailable"); }
    }
    for (const r of runs.values()) {
      const run = node(runId(r.runId) ? r.runId : "invalid-run", `run ${runId(r.runId) ? r.runId : "invalid identity"}`, "headless");
      run.owner = n;
      n.children.push(run);
      if (!runId(r.runId) || r.legacy === true || !n.file) { issue(run, "headless ownership unavailable"); run.flags.add("unknown"); continue; }
      const dir = join(sessions, "subagent-runs", r.runId), launch = metadata(dir, "launch.json", run);
      if (!launch) { issue(run, "launch source unavailable", "missing"); continue; }
      if (launch.runtimeVersion !== 2) { issue(run, "unsupported launch version", "unsupported"); continue; }
      if (launch.sessionId !== n.id || launch.id !== undefined && launch.id !== r.runId) { issue(run, "headless ownership mismatch"); continue; }
      const status = metadata(dir, "status.json", run), result = metadata(dir, "result.json", run);
      if (status && (status.runtimeVersion !== 2 || status.runId !== r.runId || status.sessionId !== undefined && status.sessionId !== n.id)) { issue(run, "unsupported or mismatched status", "unsupported"); continue; }
      if (result && (result.recordVersion !== 3 || result.runtimeVersion !== 2 || result.id !== undefined && result.id !== r.runId || result.sessionId !== undefined && result.sessionId !== n.id)) { issue(run, "unsupported or mismatched result", "unsupported"); continue; }
      const state = ["queued", "running", "complete", "failed", "blocked", "paused"].includes(str(status?.state) ?? "") ? status!.state as string : "unknown";
      run.runs.push({ id: r.runId, state });
      if (["running", "queued"].includes(state)) run.flags.add("in-flight");
      if (state === "unknown") run.flags.add("unknown");
      if (!result && !run.flags.has("in-flight")) run.flags.add("missing");
      const results = list(result?.results);
      if (results.some(c => obj(c.accounting).state !== "complete")) run.flags.add("incomplete");
      const sources = [...list(r.children), ...list(status?.steps), ...results];
      if (status?.sessionFile) sources.push({ sessionFile: status.sessionFile });
      const paths = [...new Set(sources.map(c => str(c.sessionFile)).filter((p): p is string => !!p))];
      const ownerStem = join(dirname(j.file), basename(j.file, ".jsonl"));
      if (!paths.length) { issue(run, "native run source unavailable", "missing"); continue; }
      const admitted: Node[] = [];
      for (const path of paths) {
        try {
          const rel = relative(ownerStem, path).split(sep);
          const fresh = inside(ownerStem, path) && rel.length === 3 && runId(rel[0]) && /^run-\d+$/.test(rel[1]) && rel.at(-1) === "session.jsonl";
          const fork = dirname(path) === dirname(j.file) && nativeFilename.test(basename(path));
          if (path !== resolve(path) || !fresh && !fork) throw new Error("denied source path; headless file-bound ownership unavailable");
          const cj = journal(path, fresh ? ownerStem : dirname(j.file));
          for (const error of cj.issues) issue(run, error);
          if (!safeId(cj.header.id) || results.some(c => c.sessionFile === path && c.nativeSessionId !== undefined && c.nativeSessionId !== cj.header.id) || fork && (dirname(cj.file) !== dirname(j.file) || nativeFilename.exec(basename(path))?.[1] !== cj.header.id || nativeFilename.exec(basename(cj.file))?.[1] !== cj.header.id)) throw new Error("native run identity mismatch");
          if (fork) {
            const parent = str(cj.header.parentSession);
            if (!parent || !isAbsolute(parent) || parent !== resolve(parent) || /\p{C}/u.test(parent) || !inside(sessionRoot, parent) || canonical(parent) !== j.file) throw new Error("fork owner file mismatch");
          }
          const existing = visited.get(cj.file);
          if (existing) {
            if (existing.kind !== "headless" || existing.owner !== n) { issue(run, "duplicate or cyclic run ownership"); continue; }
            existing.runs.push(...run.runs); for (const flag of run.flags) existing.flags.add(flag); admitted.push(existing); continue;
          }
          const child = paths.length === 1 ? run : node(cj.header.id, `${label(sources.find(c => c.sessionFile === path)?.agent, "worker")} ${r.runId}`, "headless");
          child.owner = n;
          child.id = cj.header.id; child.label = `${label(sources.find(c => c.sessionFile === path)?.agent, "worker")} ${r.runId}`;
          if (child !== run) { run.children.push(child); child.runs.push(...run.runs); }
          walk(cj, child); admitted.push(child);
        } catch (e) { issue(run, e instanceof Error && /^(denied|invalid source|native run|fork owner file mismatch)/.test(e.message) ? e.message : "native run source unavailable", "incomplete"); }
      }
      if (admitted.length === 1 && admitted[0] !== run && paths.length === 1 && run.issues.length === 0) {
        n.children = n.children.filter(c => c !== run); nodes.splice(nodes.indexOf(run), 1);
      }
    }
  }
  const root = node(rootId, "Session own", "root"); root.activityAllowed = true;
  const name = pi.getSessionName();
  root.label = /(^|[-_])coordinator($|[-_])/.test(name ?? "") ? "Coordinator own" : /(^|[-_])coder($|[-_])/.test(name ?? "") ? "Coder own" : "Session own";
  const ownFile = ctx.sessionManager.getSessionFile();
  const header = obj(ctx.sessionManager.getHeader());
  const rootJournal: Journal = { file: ownFile ? canonical(ownFile) : "", header, entries: ctx.sessionManager.getEntries().map(e => project(obj(e))), issues: [] };
  walk(rootJournal, root);
  if (!ownFile) issue(root, "persistent owner file unavailable; descendants cannot be admitted", "missing");

  // Normalize receipts recursively after every native source has been read, including nested aggregates.
  function expand(id: string, chain = new Set<string>()): Set<string> {
    if (conflicts.has(id)) return new Set();
    if (chain.has(id)) { conflicts.add(id); issue(root, "cyclic folded provenance"); return new Set(); }
    const refs = folds.get(id);
    if (!refs) return new Set(contributions.has(id) ? [id] : []);
    return new Set(refs.flatMap(ref => [...expand(ref, new Set([...chain, id]))]));
  }
  const nativeOwners = new Map(nodes.flatMap(n => n.raw.filter(id => !folds.has(id)).map(id => [id, n] as const)));
  const branch = (n: Node): Node[] => [n, ...n.children.flatMap(branch)];
  const keyCache = new Map<Node, Set<string>>();
  function keys(n: Node): Set<string> {
    const cached = keyCache.get(n);
    if (cached) return cached;
    const scope = new Set(branch(n));
    const own = n.raw.flatMap(id => [...expand(id)]).filter(id => {
      const owner = nativeOwners.get(id);
      if (!owner || scope.has(owner)) return true;
      if (!n.issues.includes("folded contribution outside recorded subtree")) issue(n, "folded contribution outside recorded subtree");
      return false;
    });
    const ids = new Set([...own, ...n.children.flatMap(c => [...keys(c)])]);
    keyCache.set(n, ids);
    return ids;
  }
  function sum(ids: Iterable<string>): number | null {
    // Zero-recorded rates and zero-token outcomes cannot establish historical zero spend.
    const cs = [...ids].filter(id => !conflicts.has(id)).map(id => contributions.get(id)!).filter(c => dollars(c.usage) > 0);
    return cs.length ? cs.reduce((v, c) => v + dollars(c.usage), 0) : null;
  }
  for (const n of [...nodes].reverse()) {
    n.own = sum(new Set(n.raw.filter(id => !folds.has(id)).flatMap(id => [...expand(id)])));
    if (n.own === null && n.file && n.raw.length === 0 && ![...n.flags].some(f => f !== "activity-unknown")) n.own = 0;
    n.subtree = sum(keys(n)) ?? (n.own === 0 && n.children.every(c => c.subtree === 0) ? 0 : null);
  }
  let agents: Json[] = [];
  if (process.env.HERDR_ENV === "1") {
    try {
      signal?.throwIfAborted();
      const result = await pi.exec("herdr", ["agent", "list"], { timeout: 5000, signal });
      signal?.throwIfAborted();
      if (result.code === 0 && !result.killed) agents = list(obj(obj(JSON.parse(result.stdout)).result).agents);
    } catch { signal?.throwIfAborted(); }
  }
  for (const n of nodes.filter(n => n.kind !== "headless")) {
    if (n.flags.has("not-started")) continue;
    const matches = agents.filter(a => n.activityAllowed && (n.kind === "root" || !!n.pane) && (!n.pane || a.pane_id === n.pane) && (obj(a.agent_session).kind === "id" ? obj(a.agent_session).value === n.id : obj(a.agent_session).kind === "path" && n.file && obj(a.agent_session).value === n.file));
    const status = matches.length === 1 ? str(matches[0].agent_status) : undefined;
    n.activity = status === "working" ? "working" : status === "idle" || status === "done" ? "ready" : status === "blocked" ? "blocked" : "activity unavailable";
    if (status === "working") n.flags.add("in-flight");
    if (!status || !["working", "idle", "done", "blocked"].includes(status)) n.flags.add("activity-unknown");
  }
  agents = []; // No unmatched peer metadata survives the report.
  const all = keys(root), total = root.subtree;
  const flags = [...new Set(nodes.flatMap(n => [...n.flags]))];
  const observedAt = new Date().toISOString();
  const lines = [`/costs workstream — ${rootId.slice(0, 8)} — ${observedAt}`, `Recorded total  ${money(total)} estimated${flags.includes("in-flight") ? " · usage so far" : ""}${flags.some(f => ["missing", "unpriced", "unknown", "incomplete", "unsupported"].includes(f)) ? " · coverage incomplete" : ""}`];
  const descendantFlags = (n: Node): Flag[] => [...new Set([...n.flags, ...n.children.flatMap(descendantFlags)])];
  const row = (n: Node, depth = 0) => {
    const fs = n.kind === "root" ? [...n.flags] : descendantFlags(n);
    const amount = n.kind === "headless" && !n.file && n.children.length ? `${money(n.subtree)} recorded subtree` : `${money(n.own)}${n.kind === "root" ? "" : " own"}`;
    lines.push(`${"  ".repeat(depth)}${n.label}  ${n.flags.has("not-started") ? "not started · failed before pane start" : `${amount}${n.kind === "pane" ? ` · ${money(n.subtree)} recorded subtree` : ""}${n.activity ? ` · ${n.activity}` : ""}${n.kind !== "root" && fs.includes("in-flight") && n.activity !== "working" ? " · child work running" : ""}`}${fs.filter(f => f !== "activity-unknown" && f !== "in-flight" && f !== "not-started").length ? ` · ${fs.filter(f => f !== "activity-unknown" && f !== "in-flight" && f !== "not-started").join(", ")}` : ""}`);
  };
  row(root);
  const direct = root.children.filter(n => n.kind === "headless");
  if (full) {
    const details = (n: Node, depth: number) => { row(n, depth); for (const r of n.runs) lines.push(`${"  ".repeat(depth + 1)}run ${r.id} · ${r.state}`); for (const i of n.issues) lines.push(`${"  ".repeat(depth + 1)}${i}`); for (const c of n.children) details(c, depth + 1); };
    for (const i of root.issues) lines.push(`  ${i}`);
    for (const child of root.children) details(child, 1);
    lines.push("All branches counted. Native contribution IDs deduplicate continuations and folded receipts.");
    for (const flag of flags) lines.push(`${flag}: ${definitions[flag]}.`);
  } else {
    if (direct.length) {
      const ids = new Set(direct.flatMap(n => [...keys(n)]));
      const runs = new Map(branch(root).filter(n => n.kind === "headless" && n.owner === root).flatMap(n => n.runs).map(r => [r.id, r]));
      lines.push(`Root-owned headless  ${money(sum(ids))} · ${[...runs.values()].filter(r => r.state === "complete").length} completed runs${direct.some(n => descendantFlags(n).includes("in-flight")) ? " · child work running" : ""}${direct.some(n => descendantFlags(n).some(f => ["missing", "unpriced", "unknown", "incomplete", "unsupported"].includes(f))) ? " · coverage incomplete" : ""}`);
    }
    for (const n of root.children.filter(n => n.kind === "pane")) row(n);
  }
  const displayed = new Set([...root.raw.filter(id => !folds.has(id)).flatMap(id => [...expand(id)]), ...root.children.flatMap(n => [...keys(n)])]);
  const residual = [...all].filter(id => !displayed.has(id));
  if (residual.length) lines.push(`Folded child usage  ${money(sum(residual))} · recorded without an admitted native descendant`);
  if (root.children.some(n => n.kind === "pane")) lines.push("Subtree includes own and descendants; do not add own again.");
  if (!full) lines.push("Full run details: /costs workstream full or agent_costs({mode: \"workstream\", full: true}).");
  const output: WorkstreamReport["nodes"] = [];
  const flatten = (n: Node, depth: number) => { output.push({ id: n.id, label: n.label, kind: n.kind, depth, own: n.own, subtree: n.subtree, activity: n.activity, flags: n.kind === "root" ? [...n.flags] : descendantFlags(n), issues: n.issues, runs: n.runs }); for (const c of n.children) flatten(c, depth + 1); };
  flatten(root, 0);
  return { root: rootId, observedAt, total, contributions: all.size, flags, nodes: output, text: lines.join("\n") };
}
