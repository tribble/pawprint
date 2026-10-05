// compare.ts — five-stage comparison runner: corpus → generate → grade →
// tabulate → blind/summarize. Node stdlib only, no shell, argv-array commands.
// Pi and Greptile are example argv configurations of the same execution path
// (see examples/), not plugins. Every stage reads only saved artifacts of the
// earlier ones, so re-grading and re-tabulation never re-run candidates.
//
// Saved layout under --results DIR:
//   <case>/case-input.json, prompt.md  the frozen case input, written before
//                                      any candidate of that case runs;
//                                      candidates are fed these frozen bytes
//   <case>/<candidate>/rep-N/        attempt: input.json (candidate-visible
//                                    config only — never expectations/rubric),
//                                    prompt.md, diff.patch (review cases),
//                                    stdout, stderr, meta.json (written last)
//   <case>/<candidate>/rep-N/grades/<grader>/rev-K/
//                                    one revision per grading-protocol change
//                                    (grader command/settings, rubric,
//                                    expectations, instruction bytes): answer,
//                                    prompt.md, expectations.md, rubric.md,
//                                    diff.patch, instructions/<i>-<name>
//                                    (exact external instruction bytes),
//                                    input.json (protocol + provenance),
//                                    stdout, stderr, parsed.json, meta.json
//                                    (written last)
//   .grading-XXXXXX                  per-grade mkdtemp staging: the only paths
//                                    a grader sees carry no candidate identity;
//                                    removed when the grade finishes
//   .agent-config/<sha256>/          content-addressed snapshots of declared
//                                    PI_CODING_AGENT_DIR dirs (allowlisted
//                                    non-secret config files only)
//   .agent-run-XXXXXX                per-child private runtime copy of a
//                                    config snapshot — a child never executes
//                                    the mutable source or the immutable
//                                    archive; removed after group cleanup
//   tables.md, tables.json           deterministic re-render of saved grades
//   blind.md, blind-key.json         honor-system blind reading + key
//   summary.md, summary.meta.json, summary-tables.md, summary-blind.md
//   summary-attempt.md, summary-attempt.stderr, summary-failed.meta.json,
//   summary-attempt-tables.md, summary-attempt-blind.md (pre-spawn snapshots)
//
// Usage:
//   node scripts/compare.ts generate  --corpus DIR --candidates FILE --results DIR [--reps N] [--timeout-ms N]
//   node scripts/compare.ts grade     --corpus DIR --graders FILE --results DIR [--timeout-ms N]
//   node scripts/compare.ts tabulate  --results DIR
//   node scripts/compare.ts blind     --results DIR [--seed S]
//   node scripts/compare.ts summarize --results DIR --cmd FILE [--timeout-ms N]
//
// Full config shapes and limitations: docs/model-comparison.md.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

// Longer argv elements get SIGKILLed on this machine with no log (EDR); long
// text goes via files (@file for pi) or stays short (greptile --instructions).
const ARGV_BYTE_LIMIT = 800;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // ids become directory names
const SHA_RE = /^[0-9a-f]{40}$/; // pins are immutable full SHAs, never refs
const CRITERION_RE = /^[a-z0-9][a-z0-9-]*$/; // criteria become table columns
const KILL_GRACE_MS = 2000; // SIGTERM → SIGKILL escalation window

interface CaseSpec {
  id: string;
  promptFile?: string;
  expectations?: string;
  rubric: Record<string, number>;
  repo?: string;
  base?: string;
  replay?: string;
}

interface CommandSpec {
  id: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>; // caller-declared NON-SECRET overrides; recorded in saved artifacts
}

interface AttemptMeta {
  case: string;
  candidate: string;
  rep: number;
  argv: string[];
  cwd: string;
  env?: Record<string, string>; // declared non-secret overrides, as resolved
  startedAt: string;
  durationMs: number;
  status: "ok" | "failed";
  reason?: string;
  message?: string;
  exitCode?: number | null;
  signal?: string | null;
}

interface GradeMeta {
  grader: string;
  rev: number;
  argv: string[];
  cwd: string;
  env?: Record<string, string>; // declared non-secret overrides, as resolved
  startedAt: string;
  durationMs: number;
  status: "ok" | "failed";
  reason?: string;
  message?: string;
  exitCode?: number | null;
  signal?: string | null;
}

function die(message: string): never {
  console.error(`compare: ${message}`);
  process.exit(2);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function loadJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    die(`cannot read ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    die(`invalid JSON in ${path}: ${(e as Error).message}`);
  }
}

function checkId(v: unknown, what: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) die(`${what}: id must match ${ID_RE} (it becomes a directory name); got ${JSON.stringify(v)}`);
  return v;
}

function loadCases(corpus: string): CaseSpec[] {
  const raw = loadJson(join(corpus, "cases.json"));
  if (!Array.isArray(raw) || raw.length === 0) die(`${join(corpus, "cases.json")} must be a non-empty array`);
  const seen = new Set<string>();
  return raw.map((c, i): CaseSpec => {
    if (!isRecord(c)) die(`case #${i}: not an object`);
    const id = checkId(c.id, `case #${i}`);
    if (seen.has(id)) die(`duplicate case id: ${id} — results are keyed by id; a second entry would silently mix two cases`);
    seen.add(id);
    const out: Partial<CaseSpec> = { id };
    for (const k of ["promptFile", "expectations", "repo", "base", "replay"] as const) {
      const v = c[k];
      if (v === undefined) continue;
      if (typeof v !== "string") die(`case ${id}: ${k} must be a string`);
      out[k] = v;
    }
    // A fixed per-case rubric is what makes scores comparable: every grade of
    // this case scores exactly these criteria on exactly these scales.
    if (!isRecord(c.rubric) || Object.keys(c.rubric).length === 0)
      die(`case ${id}: rubric is required — a fixed {"criterion": maxScore} object; graders must score exactly these criteria`);
    const rubric: Record<string, number> = {};
    for (const [k, v] of Object.entries(c.rubric)) {
      if (!CRITERION_RE.test(k)) die(`case ${id}: rubric criterion ${JSON.stringify(k)} must match ${CRITERION_RE} (kebab-case; it becomes a table column)`);
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) die(`case ${id}: rubric max for ${k} must be a positive integer, got ${JSON.stringify(v)}`);
      rubric[k] = v;
    }
    out.rubric = rubric;
    const reviewFields = [c.repo, c.base, c.replay].filter((x) => x !== undefined).length;
    if (reviewFields !== 0 && reviewFields !== 3) die(`case ${id}: repo, base and replay must be set together`);
    for (const k of ["base", "replay"] as const) {
      const v = out[k];
      if (v !== undefined && !SHA_RE.test(v))
        die(`case ${id}: ${k} must be a full commit SHA (40 hex chars) — a moving ref like ${JSON.stringify(v)} is not a pin`);
    }
    if (!out.promptFile && !out.repo) die(`case ${id}: set promptFile (prompt case) or repo+base+replay (review case)`);
    return out as CaseSpec;
  });
}

function loadCommands(path: string, what: string): CommandSpec[] {
  const raw = loadJson(path);
  if (!Array.isArray(raw) || raw.length === 0) die(`${path}: ${what} file must be a non-empty array of {id, argv, cwd?}`);
  const seen = new Set<string>();
  return raw.map((c, i): CommandSpec => {
    if (!isRecord(c)) die(`${what} #${i}: not an object`);
    const id = checkId(c.id, `${what} #${i}`);
    if (seen.has(id)) die(`duplicate ${what} id: ${id} — attempts/grades are keyed by id`);
    seen.add(id);
    if (!Array.isArray(c.argv) || c.argv.length === 0 || c.argv.some((a: unknown) => typeof a !== "string"))
      die(`${what} ${id}: argv must be a non-empty array of strings`);
    const out: CommandSpec = { id, argv: c.argv as string[] };
    if (c.cwd !== undefined) {
      if (typeof c.cwd !== "string") die(`${what} ${id}: cwd must be a string`);
      out.cwd = c.cwd;
    }
    if (c.env !== undefined) {
      if (!isRecord(c.env) || Object.entries(c.env).some(([k, v]) => typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)))
        die(`${what} ${id}: env must be an object of UPPER_SNAKE string values — declared non-secret overrides only (credentials stay in the real environment; values are recorded in saved artifacts)`);
      out.env = c.env as Record<string, string>;
    }
    return out;
  });
}

// Strict placeholder substitution: an unknown token — e.g. {expectations} in a
// candidate argv — is a config error. That is what keeps grading expectations
// out of candidate input. Tokens are case-sensitive but any {Word} shape is
// matched, so a typo fails loudly instead of passing through literally.
function subst(argv: string[], map: Record<string, string>, ctx: string): string[] {
  return argv.map((el) =>
    el.replace(/\{[A-Za-z]+\}/g, (tok) => {
      const v = map[tok.slice(1, -1)];
      if (v === undefined) die(`${ctx}: unknown placeholder ${tok} (known: ${Object.keys(map).sort().join(", ")})`);
      return v;
    }),
  );
}

function checkArgvBytes(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const n = Buffer.byteLength(argv[i]);
    if (n > ARGV_BYTE_LIMIT)
      return `argv[${i}] is ${n} bytes (limit ${ARGV_BYTE_LIMIT}): pass long text via a file instead (pi: @file; greptile --instructions has no file form — keep it short)`;
  }
  return null;
}

// --- bounded subprocess execution ---------------------------------------------

interface RunOutcome {
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  error?: Error;
}

// Every child runs as its own process-group leader (detached). The timeout
// bound is real: SIGTERM the group, then SIGKILL after a grace window, so a
// child that traps SIGTERM (or a shell wrapper around a paid remote call)
// cannot block the sequential run or keep spending past the verdict. On a
// clean fast exit the group still gets SIGTERM — a candidate that backgrounded
// a helper must not leak it past the runner's verdict. Output streams go
// straight to files, so partial stdout/stderr survive the runner being killed.
// ponytail: POSIX-only process groups; a double-fork+setsid escapee is out of scope.
let activePid: number | undefined;

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

// Operator interrupt: the child is detached, so the terminal's SIGINT never
// reaches it — kill the group explicitly before dying. The interrupted
// attempt/grade keeps its partial streams and has no meta.json (written last),
// which is exactly how tabulate reports it as interrupted.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    killGroup(activePid, "SIGKILL");
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

function runCommand(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  outPath: string,
  errPath: string,
  env?: Record<string, string>,
): Promise<RunOutcome> {
  return new Promise((resolvePromise) => {
    let outFd: number;
    let errFd: number;
    try {
      outFd = openSync(outPath, "w");
      errFd = openSync(errPath, "w");
    } catch (e) {
      resolvePromise({ status: null, signal: null, timedOut: false, error: e as Error });
      return;
    }
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let settled = false;
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (r: RunOutcome): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      activePid = undefined;
      try {
        closeSync(outFd);
      } catch {
        // already closed
      }
      try {
        closeSync(errFd);
      } catch {
        // already closed
      }
      resolvePromise(r);
    };
    const groupGone = (): boolean => {
      try {
        process.kill(-(child.pid as number), 0);
        return false;
      } catch {
        return true; // ESRCH: nothing left in the group
      }
    };
    // Group cleanup finishes BEFORE the verdict: SIGTERM the group, probe, and
    // if anything survives (a helper that ignores SIGTERM), SIGKILL after the
    // grace window and resolve only then. The leader's own exit — the event
    // that strands a stubborn grandchild — never cancels this.
    const reap = (r: RunOutcome): void => {
      const pid = child.pid;
      killGroup(pid, "SIGTERM");
      if (groupGone()) return done(r);
      timers.push(
        setTimeout(() => {
          killGroup(pid, "SIGKILL");
          done(r);
        }, KILL_GRACE_MS),
      );
    };
    child.on("error", (error) => done({ status: null, signal: null, timedOut: false, error }));
    child.on("exit", (status, signal) => reap({ status, signal, timedOut }));
    activePid = child.pid;
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, "SIGTERM");
        // Unconditional: a cooperative leader's exit must not cancel this.
        timers.push(setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS));
        // SIGKILL is untrappable, but never let a wedged child block the run.
        timers.push(setTimeout(() => done({ status: null, signal: "SIGKILL", timedOut: true }), KILL_GRACE_MS * 3));
      }, timeoutMs),
    );
  });
}

function gitOut(repo: string, args: string[]): { code: number | null; out: string; raw: string; err: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "").trim(), raw: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

// Caller prepares the checkout; the runner only verifies the directory the
// candidate actually runs in. Never fetch, switch, or clean anything here.
function reviewGuards(cwd: string, base: string, replay: string): string | null {
  if (!existsSync(cwd)) return `cwd does not exist: ${cwd} — set the candidate cwd to the pinned checkout`;
  const head = gitOut(cwd, ["rev-parse", "HEAD"]);
  if (head.code !== 0) return `not a git repository: ${cwd}: ${head.err}`;
  if (head.out !== replay)
    return `HEAD is ${head.out}, expected pinned replay ${replay} — check out the replay commit yourself; the runner never switches branches`;
  const dirty = gitOut(cwd, ["status", "--porcelain"]);
  if (dirty.out !== "") return `worktree is not clean: ${cwd} — the review must cover exactly the pinned base→replay diff`;
  const anc = gitOut(cwd, ["merge-base", "--is-ancestor", base, replay]);
  if (anc.code !== 0) return `base ${base} is not an ancestor of replay ${replay} — the reviewed merge-base→HEAD diff would not be the pinned one`;
  return null;
}

function need(v: string | undefined, flag: string): string {
  if (!v) die(`${flag} is required`);
  return v;
}

function parseCount(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) die(`${flag} must be a positive integer, got ${JSON.stringify(v)}`);
  return n;
}

function opts(args: string[], options: Record<string, { type: "string" }>): Record<string, string | undefined> {
  try {
    return parseArgs({ args, options, strict: true }).values;
  } catch (e) {
    die((e as Error).message);
  }
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedDirs(p: string): string[] {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(cmpStr);
}

function hash(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

// A declared PI_CODING_AGENT_DIR is non-secret, caller-controlled config.
// Only these top-level files are effective pi configuration; README.md is
// documentation and ignored. Anything else — credentials (auth.json,
// mcp-auth.json), runtime state (sessions/, …), symlinks (including dangling
// ones), subdirectories — is REFUSED before a single byte is read, copied, or
// spawned, so credential/runtime files can never land in the results tree.
const AGENT_CONFIG_FILES = ["models.json", "settings.json", "SYSTEM.md", "APPEND_SYSTEM.md"];

function agentConfigHint(dir: string): string {
  return `PI_CODING_AGENT_DIR ${dir}: a controlled agent dir may contain only top-level ${AGENT_CONFIG_FILES.join(", ")} (an optional README.md is ignored) — credentials, runtime state, symlinks and subdirectories must never be placed there; see examples/pi-agent/README.md`;
}

// Snapshot the declared dir's effective config bytes (deduped by content
// hash) so a run's exact pi configuration is reconstructible from the results
// tree alone. Validated and snapshotted once per invocation, before any child
// is launched, and reused by every arm: same-invocation source mutation
// cannot change another arm's effective config, while a later rerun re-hashes
// the source and rejects drift under existing ids (checkFrozen).
function snapshotAgentConfig(results: string, dir: string, cache: Map<string, string>): { dir: string; sha256: string } {
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    die(`PI_CODING_AGENT_DIR is not a directory: ${dir} — create it (see examples/pi-agent/README.md); never point it at your live ~/.pi/agent`);
  let sha256 = cache.get(dir);
  if (!sha256) {
    // Dirent types come from lstat: symlinks are refused without following.
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmpStr(a.name, b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) die(`${agentConfigHint(dir)}\n  refused entry: ${JSON.stringify(e.name)} is a symlink`);
      if (!e.isFile()) die(`${agentConfigHint(dir)}\n  refused entry: ${JSON.stringify(e.name)} is not a plain file`);
      if (e.name !== "README.md" && !AGENT_CONFIG_FILES.includes(e.name)) die(`${agentConfigHint(dir)}\n  refused entry: ${JSON.stringify(e.name)}`);
    }
    const files = entries.filter((e) => e.name !== "README.md");
    const h = createHash("sha256");
    for (const e of files) {
      h.update(e.name);
      h.update("\0");
      h.update(readFileSync(join(dir, e.name)));
      h.update("\0");
    }
    sha256 = h.digest("hex");
    cache.set(dir, sha256);
    const dest = join(results, ".agent-config", sha256);
    if (!existsSync(dest)) {
      // copy-then-rename so an interrupted snapshot never masquerades as complete
      const tmp = `${dest}.tmp-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      for (const e of files) copyFileSync(join(dir, e.name), join(tmp, e.name));
      renameSync(tmp, dest);
    }
  }
  return { dir, sha256 };
}

// One controlled child execution: when a PI_CODING_AGENT_DIR is declared, the
// child runs against a PRIVATE per-process copy of the validated snapshot —
// never the mutable source, never the content-addressed archive (pi writes
// runtime state into its agent dir, and the archive must stay byte-frozen).
// The recorded env keeps the logical source path, so a rerun is never
// rejected over a random runtime path. The copy is removed after the child's
// process-group cleanup has completed.
async function runControlled(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  outPath: string,
  errPath: string,
  env: Record<string, string> | undefined,
  agentConfig: { dir: string; sha256: string } | null | undefined,
  results: string,
): Promise<RunOutcome> {
  if (!agentConfig || !env?.PI_CODING_AGENT_DIR) return runCommand(argv, cwd, timeoutMs, outPath, errPath, env);
  const runtime = mkdtempSync(join(results, ".agent-run-"));
  try {
    cpSync(join(results, ".agent-config", agentConfig.sha256), runtime, { recursive: true });
    return await runCommand(argv, cwd, timeoutMs, outPath, errPath, { ...env, PI_CODING_AGENT_DIR: runtime });
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
}

// Resolve declared env values (placeholders allowed). PI_CODING_AGENT_DIR is
// resolved against the config dir so relative paths work in examples.
function resolveEnv(
  spec: Record<string, string> | undefined,
  map: Record<string, string>,
  configDir: string,
  ctx: string,
): Record<string, string> | undefined {
  if (!spec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec)) out[k] = subst([v], map, `${ctx} env ${k}`)[0];
  if (out.PI_CODING_AGENT_DIR) out.PI_CODING_AGENT_DIR = resolve(configDir, out.PI_CODING_AGENT_DIR);
  return out;
}

// A grader argv token like `@file` or `@{configDir}/file` that names an
// existing file and carries no runner-provided placeholder is a DECLARED
// MODEL INPUT (grading instruction): its exact bytes are snapshotted per
// revision and the grader executes the snapshot. A bare `@file` resolves
// against the effective grader cwd — the directory the child would read it
// from; `@{configDir}/...` is the explicit config-relative form.
// `@{output}`/`@{expectations}`/`@{rubric}`/… stay runner-provided.
// Executables (argv[0]) are never relocated — a copied script with relative
// imports would break.
function externalFileToken(el: string, configDir: string, cwd: string): { element: string; path: string } | null {
  if (!el.startsWith("@")) return null;
  const raw = el.slice(1);
  if (/\{[A-Za-z]+\}/.test(raw.replaceAll("{configDir}", ""))) return null; // runner-provided placeholder token
  const inner = raw.replaceAll("{configDir}", configDir);
  return { element: `@${inner}`, path: resolve(raw.includes("{configDir}") ? configDir : cwd, inner) };
}

interface ProtocolFile {
  as: string;
  element: string;
  path: string;
  sha256: string;
}

// Grading protocol identity: grader command/settings (raw argv/cwd/env), the
// fixed rubric, the expectations, the exact bytes of declared instruction
// files, and the controlled pi config hash. Any change = a new revision,
// never a silent skip, and never one table with the old protocol. The answer
// being graded is deliberately NOT part of this identity.
function buildProtocol(
  g: CommandSpec,
  c: CaseSpec,
  expText: string,
  configDir: string,
  cwd: string,
  results: string,
  agentCache: Map<string, string>,
): { protocol: Record<string, unknown>; files: ProtocolFile[]; agentConfig: { dir: string; sha256: string } | null } {
  const files: ProtocolFile[] = [];
  for (const el of g.argv) {
    const ext = externalFileToken(el, configDir, cwd);
    if (!ext) continue;
    if (!existsSync(ext.path) || !statSync(ext.path).isFile())
      die(`grader ${g.id}: instruction file not found: ${ext.path} — grader @file tokens must name existing files; their exact bytes are snapshotted with each grade revision`);
    files.push({ as: `${files.length}-${basename(ext.path)}`, ...ext, sha256: hash(readFileSync(ext.path)) });
  }
  let agentConfig: { dir: string; sha256: string } | null = null;
  if (g.env?.PI_CODING_AGENT_DIR) {
    const dir = resolve(configDir, subst([g.env.PI_CODING_AGENT_DIR], { configDir }, `grader ${g.id} env PI_CODING_AGENT_DIR`)[0]);
    agentConfig = snapshotAgentConfig(results, dir, agentCache);
  }
  const protocol = {
    argv: g.argv,
    cwd: g.cwd ?? null,
    env: g.env ? Object.fromEntries(Object.entries(g.env).sort(([a], [b]) => cmpStr(a, b))) : null,
    expectations: expText,
    rubric: Object.fromEntries(Object.entries(c.rubric).sort(([a], [b]) => cmpStr(a, b))),
    instructions: files.map((f) => ({ as: f.as, sha256: f.sha256 })),
    agentConfig: agentConfig?.sha256 ?? null,
  };
  return { protocol, files, agentConfig };
}

// Revision directories of one grader under one attempt, ascending.
function revNums(gbase: string): number[] {
  return sortedDirs(gbase)
    .map((d) => /^rev-(\d+)$/.exec(d)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

interface AttemptRef {
  caseId: string;
  candId: string;
  rep: number;
  path: string;
  meta: AttemptMeta | null; // null = interrupted mid-spawn (meta.json is written last)
}

function listAttempts(results: string): AttemptRef[] {
  const out: AttemptRef[] = [];
  for (const caseId of sortedDirs(results)) {
    for (const candId of sortedDirs(join(results, caseId))) {
      for (const repName of sortedDirs(join(results, caseId, candId))) {
        const m = /^rep-(\d+)$/.exec(repName);
        if (!m) continue;
        const path = join(results, caseId, candId, repName);
        let meta: AttemptMeta | null = null;
        try {
          meta = JSON.parse(readFileSync(join(path, "meta.json"), "utf8")) as AttemptMeta;
        } catch {
          meta = null;
        }
        out.push({ caseId, candId, rep: Number(m[1]), path, meta });
      }
    }
  }
  out.sort((a, b) => cmpStr(a.caseId, b.caseId) || cmpStr(a.candId, b.candId) || a.rep - b.rep);
  return out;
}

// --- generate ----------------------------------------------------------------

// The candidate-visible slice of a case: never expectations, never the rubric.
function visibleCase(c: CaseSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { id: c.id };
  if (c.promptFile) out.promptFile = c.promptFile;
  if (c.repo) {
    out.repo = c.repo;
    out.base = c.base;
    out.replay = c.replay;
  }
  return out;
}

// A results directory is one frozen data set: an existing attempt whose saved
// inputs no longer match the current corpus/candidate config means the operator
// is about to mix two data sets under the same ids. Refuse, loudly.
function checkFrozen(dir: string, inputDoc: unknown, frozenPrompt: string | undefined, argv: string[], cwd: string, label: string): void {
  const hint = `use a fresh --results directory (or delete ${dir}) — results must never mix changed inputs under the same case/candidate ids`;
  const inputPath = join(dir, "input.json");
  if (existsSync(inputPath)) {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(inputPath, "utf8"));
    } catch {
      saved = undefined;
    }
    if (saved !== undefined && JSON.stringify(saved) !== JSON.stringify(inputDoc))
      die(`${label}: different saved inputs than the current configuration — ${hint}`);
  }
  const promptCopy = join(dir, "prompt.md");
  if (frozenPrompt && existsSync(promptCopy) && !readFileSync(promptCopy).equals(readFileSync(frozenPrompt)))
    die(`${label}: the prompt file has different saved inputs in ${promptCopy} than the frozen case input — ${hint}`);
  const metaPath = join(dir, "meta.json");
  if (existsSync(metaPath)) {
    let saved: AttemptMeta | undefined;
    try {
      saved = JSON.parse(readFileSync(metaPath, "utf8")) as AttemptMeta;
    } catch {
      saved = undefined;
    }
    if (saved && (JSON.stringify(saved.argv) !== JSON.stringify(argv) || saved.cwd !== cwd))
      die(`${label}: resolved argv/cwd have different saved inputs in meta.json — ${hint}`);
  }
}

async function runAttempt(
  c: CaseSpec,
  cand: CommandSpec,
  rep: number,
  argv: string[],
  cwd: string,
  frozenPrompt: string | undefined,
  env: Record<string, string> | undefined,
  agentConfig: { dir: string; sha256: string } | undefined,
  timeoutMs: number,
  results: string,
  dir: string,
): Promise<AttemptMeta> {
  const start = Date.now();
  const meta: AttemptMeta = { case: c.id, candidate: cand.id, rep, argv, cwd, startedAt: new Date(start).toISOString(), durationMs: 0, status: "failed" };
  if (env) meta.env = env;
  const finish = (patch: Partial<AttemptMeta>): AttemptMeta => {
    Object.assign(meta, patch);
    meta.durationMs = Date.now() - start;
    return meta;
  };
  // Snapshot exact inputs first, so even a failed attempt keeps full context.
  // Expectations and the rubric stay out: they are grader-only data and must
  // not sit in the tree a tool-enabled candidate runs in.
  writeFileSync(
    join(dir, "input.json"),
    `${JSON.stringify({ case: visibleCase(c), candidate: cand, ...(agentConfig ? { agentConfig } : {}) }, null, 2)}\n`,
  );
  if (frozenPrompt) copyFileSync(frozenPrompt, join(dir, "prompt.md"));
  const tooLong = checkArgvBytes(argv);
  if (tooLong) return finish({ reason: "argv-limit", message: tooLong });
  if (c.repo) {
    // The guard binds the pinned base→replay pair to the directory the
    // candidate actually runs in — not to a repo path that is only on paper.
    const guard = reviewGuards(cwd, c.base as string, c.replay as string);
    if (guard) return finish({ reason: "guard", message: guard });
    const diff = gitOut(cwd, ["diff", c.base as string, c.replay as string]);
    if (diff.code !== 0) return finish({ reason: "guard", message: `cannot snapshot the pinned diff: ${diff.err}` });
    writeFileSync(join(dir, "diff.patch"), diff.raw);
  }
  if (!existsSync(cwd)) return finish({ reason: "spawn-error", message: `cwd does not exist: ${cwd}` });
  const r = await runControlled(argv, cwd, timeoutMs, join(dir, "stdout"), join(dir, "stderr"), env, agentConfig, results);
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return finish({ reason: "spawn-error", message: `executable not found: ${argv[0]} — install it or set an absolute path in the candidates file (never auto-installed)` });
    return finish({ reason: "spawn-error", message: String(r.error) });
  }
  meta.exitCode = r.status;
  meta.signal = r.signal;
  if (r.timedOut) return finish({ reason: "timeout", message: `exceeded ${timeoutMs}ms; process group terminated` });
  if (r.signal) return finish({ reason: "signal", message: `killed by ${r.signal}` });
  if (r.status !== 0) return finish({ reason: "nonzero-exit", message: `exit code ${r.status}` });
  return finish({ status: "ok" });
}

async function cmdGenerate(args: string[]): Promise<void> {
  const values = opts(args, { corpus: { type: "string" }, candidates: { type: "string" }, results: { type: "string" }, reps: { type: "string" }, "timeout-ms": { type: "string" } });
  const corpus = resolve(need(values.corpus, "--corpus"));
  const candidatesPath = resolve(need(values.candidates, "--candidates"));
  const results = resolve(need(values.results, "--results"));
  const reps = parseCount(values.reps ?? "1", "--reps");
  const timeoutMs = parseCount(values["timeout-ms"] ?? "1800000", "--timeout-ms");
  const cases = loadCases(corpus);
  const candidates = loadCommands(candidatesPath, "candidate");
  const configDir = dirname(candidatesPath);
  mkdirSync(results, { recursive: true });
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  const agentCache = new Map<string, string>();
  // Validate and snapshot every declared controlled agent dir BEFORE any
  // child is launched: a refused config (credentials, symlinks, unexpected
  // entries) must never surface after earlier arms have already run.
  for (const c of cases) {
    const m: Record<string, string> = { configDir };
    if (c.promptFile) m.prompt = join(results, c.id, "prompt.md");
    if (c.repo) {
      m.repo = c.repo;
      m.base = c.base as string;
      m.replay = c.replay as string;
    }
    for (const cand of candidates) {
      const env = resolveEnv(cand.env, m, configDir, `candidate ${cand.id}`);
      if (env?.PI_CODING_AGENT_DIR) snapshotAgentConfig(results, env.PI_CODING_AGENT_DIR, agentCache);
    }
  }
  for (const c of cases) {
    const promptAbs = c.promptFile ? resolve(corpus, c.promptFile) : undefined;
    if (promptAbs && !existsSync(promptAbs)) die(`case ${c.id}: prompt file not found: ${promptAbs}`);
    // Freeze the common case input ONCE, before any candidate of this case
    // runs: every candidate arm — including arms added by a later invocation —
    // answers the same frozen bytes, and a changed case input is rejected at
    // the case level no matter which candidates are being (re)visited.
    const caseDir = join(results, c.id);
    const manifestPath = join(caseDir, "case-input.json");
    const frozenPrompt = promptAbs ? join(caseDir, "prompt.md") : undefined;
    const manifest = {
      id: c.id,
      promptFile: c.promptFile ?? null,
      promptSha256: promptAbs ? hash(readFileSync(promptAbs)) : null,
      repo: c.repo ?? null,
      base: c.base ?? null,
      replay: c.replay ?? null,
    };
    if (existsSync(manifestPath)) {
      let saved: unknown;
      try {
        saved = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        saved = undefined;
      }
      if (saved === undefined || JSON.stringify(saved) !== JSON.stringify(manifest))
        die(
          `case ${c.id}: different saved case input than the current corpus (prompt bytes, promptFile, or pinned repo/base/replay changed) — use a fresh --results directory; results never mix changed case inputs`,
        );
    } else {
      mkdirSync(caseDir, { recursive: true });
      if (promptAbs && frozenPrompt) copyFileSync(promptAbs, frozenPrompt);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const caseMap: Record<string, string> = { configDir };
    if (frozenPrompt) caseMap.prompt = frozenPrompt;
    if (c.repo) {
      caseMap.repo = c.repo;
      caseMap.base = c.base as string;
      caseMap.replay = c.replay as string;
    }
    for (const cand of candidates) {
      const argv = subst(cand.argv, caseMap, `candidate ${cand.id}`);
      const cwd = cand.cwd ? resolve(configDir, subst([cand.cwd], caseMap, `candidate ${cand.id} cwd`)[0]) : process.cwd();
      const env = resolveEnv(cand.env, caseMap, configDir, `candidate ${cand.id}`);
      const agentConfig = env?.PI_CODING_AGENT_DIR ? snapshotAgentConfig(results, env.PI_CODING_AGENT_DIR, agentCache) : undefined;
      const inputDoc = { case: visibleCase(c), candidate: cand, ...(agentConfig ? { agentConfig } : {}) };
      for (let rep = 1; rep <= reps; rep++) {
        const label = `${c.id}/${cand.id}/rep-${rep}`;
        const dir = join(results, c.id, cand.id, `rep-${rep}`);
        if (existsSync(dir)) {
          checkFrozen(dir, inputDoc, frozenPrompt, argv, cwd, label);
          skipped++;
          console.log(`skip ${label} (exists; delete the directory to retry)`);
          continue;
        }
        mkdirSync(dir, { recursive: true });
        const meta = await runAttempt(c, cand, rep, argv, cwd, frozenPrompt, env, agentConfig, timeoutMs, results, dir);
        writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
        if (meta.status === "ok") {
          ok++;
          console.log(`ok ${label} (${meta.durationMs}ms)`);
        } else {
          failed++;
          console.log(`FAILED ${label}: ${meta.reason} — ${meta.message ?? ""}`);
        }
      }
    }
  }
  console.log(`generate done: ${ok} ok, ${failed} failed, ${skipped} skipped`);
}

// --- grade --------------------------------------------------------------------

interface GradeJson {
  criteria: Record<string, number>;
  notes?: string;
}

type GradeParse = { ok: true; grade: GradeJson } | { ok: false; reason: "unparseable" | "rubric-mismatch"; message: string };

// Grader contract: the FINAL ```json opening in stdout — and only it — must
// be matched by its own closing fence and parse to {"criteria": {<name>:
// <integer>}, "notes"?: "..."} whose criteria are exactly the case's fixed
// rubric, each within its 0..max scale. A valid earlier block followed by a
// malformed or unterminated final one is a failed grade, never a score.
function parseGrade(text: string, rubric: Record<string, number>): GradeParse {
  // An opening truncated at EOF (no trailing newline) still matches, and then
  // fails "never closed" below — never a fallback to an earlier valid block.
  const opens = [...text.matchAll(/```json[^\n]*(?:\n|$)/g)];
  const last = opens.at(-1);
  if (!last || last.index === undefined) return { ok: false, reason: "unparseable", message: "no ```json block in grader output" };
  const rest = text.slice(last.index + last[0].length);
  const close = rest.indexOf("```");
  if (close === -1)
    return { ok: false, reason: "unparseable", message: "final ```json block is never closed — truncated grader output is a failed grade, not a grade" };
  let v: unknown;
  try {
    v = JSON.parse(rest.slice(0, close));
  } catch (e) {
    return { ok: false, reason: "unparseable", message: `final \`\`\`json block is not valid JSON: ${(e as Error).message}` };
  }
  if (!isRecord(v) || !isRecord(v.criteria)) return { ok: false, reason: "unparseable", message: 'final ```json block is not {"criteria": {...}}' };
  const got = Object.keys(v.criteria).sort(cmpStr);
  const want = Object.keys(rubric).sort(cmpStr);
  if (got.join("\n") !== want.join("\n"))
    return { ok: false, reason: "rubric-mismatch", message: `criteria ${JSON.stringify(got)} do not match the case's fixed rubric ${JSON.stringify(want)}` };
  const criteria: Record<string, number> = {};
  for (const [k, val] of Object.entries(v.criteria)) {
    if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > rubric[k])
      return { ok: false, reason: "rubric-mismatch", message: `criterion ${k}: ${JSON.stringify(val)} is not an integer in 0..${rubric[k]}` };
    criteria[k] = val;
  }
  return { ok: true, grade: { criteria, notes: typeof v.notes === "string" ? v.notes : undefined } };
}

function renderRubric(rubric: Record<string, number>): string {
  const lines = ["# Fixed rubric — score exactly these criteria, no others", ""];
  for (const k of Object.keys(rubric).sort(cmpStr)) lines.push(`- ${k}: 0..${rubric[k]}`);
  return `${lines.join("\n")}\n`;
}

async function cmdGrade(args: string[]): Promise<void> {
  const values = opts(args, { corpus: { type: "string" }, graders: { type: "string" }, results: { type: "string" }, "timeout-ms": { type: "string" } });
  const corpus = resolve(need(values.corpus, "--corpus"));
  const gradersPath = resolve(need(values.graders, "--graders"));
  const results = resolve(need(values.results, "--results"));
  const timeoutMs = parseCount(values["timeout-ms"] ?? "1800000", "--timeout-ms");
  const cases = new Map(loadCases(corpus).map((c) => [c.id, c]));
  const graders = loadCommands(gradersPath, "grader");
  const configDir = dirname(gradersPath);
  const agentCache = new Map<string, string>();
  // Validate and snapshot every declared controlled agent dir BEFORE any
  // grader is launched: a refused config must never surface after earlier
  // grades have already run.
  for (const g of graders) {
    if (!g.env?.PI_CODING_AGENT_DIR) continue;
    const dir = resolve(configDir, subst([g.env.PI_CODING_AGENT_DIR], { configDir }, `grader ${g.id} env PI_CODING_AGENT_DIR`)[0]);
    snapshotAgentConfig(results, dir, agentCache);
  }
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const a of listAttempts(results)) {
    if (!a.meta || a.meta.status !== "ok") continue; // failures have nothing to grade; tabulate reports them
    const c = cases.get(a.caseId);
    if (!c) {
      console.log(`skip ${a.caseId}: not in corpus`);
      continue;
    }
    const expText = `${c.expectations ?? "(no expectations recorded for this case)"}\n`;
    const rubricText = renderRubric(c.rubric);
    for (const g of graders) {
      const label = `${a.caseId}/${a.candId}/rep-${a.rep} ${g.id}`;
      // The effective grader cwd is decided once and shared by instruction
      // resolution (a bare @file is cwd-relative) and the spawn below. The
      // per-grade staging map cannot affect it (a cwd inside staging would be
      // a different protocol per revision), so only {configDir} is known here.
      const cwd = g.cwd ? resolve(configDir, subst([g.cwd], { configDir }, `grader ${g.id} cwd`)[0]) : process.cwd();
      // Grading protocol identity: grader command/settings, fixed rubric,
      // expectations, and the exact bytes of every declared instruction file.
      const { protocol, files, agentConfig } = buildProtocol(g, c, expText, configDir, cwd, results, agentCache);
      const gbase = join(a.path, "grades", g.id);
      const revs = revNums(gbase);
      const latest = revs.at(-1);
      let sameProtocol = false;
      if (latest !== undefined) {
        try {
          const saved: unknown = JSON.parse(readFileSync(join(gbase, `rev-${latest}`, "input.json"), "utf8"));
          sameProtocol = isRecord(saved) && JSON.stringify(saved.protocol) === JSON.stringify(protocol);
        } catch {
          sameProtocol = false; // unreadable input.json: never silently skip
        }
        if (sameProtocol && existsSync(join(gbase, `rev-${latest}`, "meta.json"))) {
          skipped++;
          continue; // graded with this exact protocol already (delete a rev dir to force)
        }
      }
      // A changed grading protocol (or an interrupted previous attempt) gets a
      // NEW revision; earlier revisions and their inputs are never erased.
      const rev = (latest ?? 0) + 1;
      const revDir = join(gbase, `rev-${rev}`);
      mkdirSync(revDir, { recursive: true });
      const start = Date.now();
      const meta: GradeMeta = { grader: g.id, rev, argv: [], cwd: "", startedAt: new Date(start).toISOString(), durationMs: 0, status: "failed" };
      const finish = (patch: Partial<GradeMeta>): void => {
        Object.assign(meta, patch);
        meta.durationMs = Date.now() - start;
        writeFileSync(join(revDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
      };
      // Canonical grading inputs for this revision, including the exact
      // instruction bytes the grader will execute.
      writeFileSync(join(revDir, "expectations.md"), expText);
      writeFileSync(join(revDir, "rubric.md"), rubricText);
      copyFileSync(join(a.path, "stdout"), join(revDir, "answer"));
      const hasPrompt = existsSync(join(a.path, "prompt.md"));
      if (hasPrompt) copyFileSync(join(a.path, "prompt.md"), join(revDir, "prompt.md"));
      const hasDiff = existsSync(join(a.path, "diff.patch"));
      if (hasDiff) copyFileSync(join(a.path, "diff.patch"), join(revDir, "diff.patch"));
      if (files.length > 0) {
        mkdirSync(join(revDir, "instructions"), { recursive: true });
        for (const f of files) copyFileSync(f.path, join(revDir, "instructions", f.as));
      }
      // Unique neutral staging per grading invocation: the only paths a grader
      // is ever pointed at carry no candidate identity and are never shared
      // with another grade; removed when the grade finishes (canonical bytes
      // stay in the revision dir).
      const stage = mkdtempSync(join(results, ".grading-"));
      try {
        for (const f of ["answer", "expectations.md", "rubric.md", "prompt.md", "diff.patch"]) {
          if (existsSync(join(revDir, f))) copyFileSync(join(revDir, f), join(stage, f));
        }
        for (const f of files) copyFileSync(join(revDir, "instructions", f.as), join(stage, f.as));
        const map: Record<string, string> = {
          configDir,
          output: join(stage, "answer"),
          expectations: join(stage, "expectations.md"),
          rubric: join(stage, "rubric.md"),
        };
        if (hasPrompt) map.prompt = join(stage, "prompt.md");
        if (hasDiff) map.diff = join(stage, "diff.patch");
        const instByElement = new Map(files.map((f) => [f.element, f.as]));
        const argv = subst(g.argv, map, `grader ${g.id}`).map((el) => {
          const as = instByElement.get(el);
          return as ? `@${join(stage, as)}` : el; // the grader executes the snapshot, not the source file
        });
        meta.argv = argv;
        const env = resolveEnv(g.env, map, configDir, `grader ${g.id}`);
        if (env) meta.env = env;
        meta.cwd = cwd;
        // Provenance: the full protocol, the source attempt, and content
        // hashes (over raw bytes) of every file the resolved argv references.
        const argvFiles: Record<string, string> = {};
        for (const el of argv) {
          const p = el.startsWith("@") ? el.slice(1) : el;
          try {
            if (statSync(p).isFile()) argvFiles[el] = hash(readFileSync(p));
          } catch {
            // not a file: a flag or value, nothing to hash
          }
        }
        writeFileSync(
          join(revDir, "input.json"),
          `${JSON.stringify(
            {
              protocol,
              source: { case: a.caseId, candidate: a.candId, rep: a.rep, attempt: relative(results, a.path) },
              ...(agentConfig ? { agentConfig } : {}),
              argvFiles,
            },
            null,
            2,
          )}\n`,
        );
        const tooLong = checkArgvBytes(argv);
        if (tooLong) {
          finish({ reason: "argv-limit", message: tooLong });
          failed++;
          console.log(`FAILED grade ${label}: argv-limit — ${tooLong}`);
          continue;
        }
        if (!existsSync(cwd)) {
          finish({ reason: "spawn-error", message: `cwd does not exist: ${cwd}` });
          failed++;
          console.log(`FAILED grade ${label}: cwd does not exist: ${cwd}`);
          continue;
        }
        const r = await runControlled(argv, cwd, timeoutMs, join(revDir, "stdout"), join(revDir, "stderr"), env, agentConfig, results);
        meta.exitCode = r.status;
        meta.signal = r.signal;
        if (r.error || r.timedOut || r.signal || r.status !== 0) {
          const code = r.error ? (r.error as NodeJS.ErrnoException).code : undefined;
          const reason = code === "ENOENT" ? "spawn-error" : r.timedOut ? "timeout" : r.signal ? "signal" : "nonzero-exit";
          const detail =
            code === "ENOENT"
              ? `executable not found: ${argv[0]} — install it or set an absolute path (never auto-installed)`
              : r.timedOut
                ? `timeout after ${timeoutMs}ms; process group terminated`
                : r.signal
                  ? `killed by ${r.signal}`
                  : `exit code ${r.status}`;
          finish({ reason, message: detail });
          failed++;
          console.log(`FAILED grade ${label}: ${detail}`);
          continue;
        }
        const parsed = parseGrade(readFileSync(join(revDir, "stdout"), "utf8"), c.rubric);
        if (!parsed.ok) {
          finish({ reason: parsed.reason, message: parsed.message });
          failed++;
          console.log(`FAILED grade ${label}: ${parsed.reason} — ${parsed.message}`);
          continue;
        }
        writeFileSync(join(revDir, "parsed.json"), `${JSON.stringify(parsed.grade, null, 2)}\n`);
        finish({ status: "ok" });
        ok++;
        console.log(`ok grade ${label} (${meta.durationMs}ms)`);
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
  }
  console.log(`grade done: ${ok} ok, ${failed} failed, ${skipped} skipped`);
}

// --- tabulate ------------------------------------------------------------------

interface GradeRow {
  candidate: string;
  rep: number;
  criteria: Record<string, number>;
  total: number;
  maxTotal: number;
  notes?: string;
}

// Model-written text lands in a human-read document: neutralize markdown
// structure (pipes forge table rows, newlines forge entries).
function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
}

function cmdTabulate(args: string[]): void {
  const values = opts(args, { results: { type: "string" } });
  const results = resolve(need(values.results, "--results"));
  const attempts = listAttempts(results);
  const lines: string[] = [
    "# Comparison tables",
    "",
    "Deterministic re-render of saved grades: identical saved inputs produce identical bytes. Re-analyze from the raw grades beside each attempt (grades/<grader>/rev-N/).",
    "",
  ];
  const jsonOut: unknown[] = [];
  for (const caseId of [...new Set(attempts.map((a) => a.caseId))]) {
    lines.push(`## Case ${caseId}`, "");
    const caseAttempts = attempts.filter((a) => a.caseId === caseId);
    const failures: string[] = [];
    const graderIds = [...new Set(caseAttempts.flatMap((a) => sortedDirs(join(a.path, "grades"))))].sort(cmpStr);
    const jsonGraders: unknown[] = [];
    for (const gid of graderIds) {
      // Rows grouped by grading protocol: a grade taken under a changed
      // protocol (grader command/settings, rubric, expectations, instruction
      // bytes) is data from a different instrument, never blended into one
      // Total column.
      const groups = new Map<string, GradeRow[]>();
      for (const a of caseAttempts) {
        if (!a.meta || a.meta.status !== "ok") continue;
        const gbase = join(a.path, "grades", gid);
        if (!existsSync(gbase)) continue; // grader not run on this attempt (yet)
        const revs = revNums(gbase);
        if (revs.length === 0) {
          failures.push(`${a.candId} rep-${a.rep}: grade ${gid} interrupted (no completed revision)`);
          continue;
        }
        const revDir = join(gbase, `rev-${revs.at(-1)}`);
        const gmetaPath = join(revDir, "meta.json");
        if (!existsSync(gmetaPath)) {
          failures.push(`${a.candId} rep-${a.rep}: grade ${gid} interrupted (rev-${revs.at(-1)} has no meta.json)`);
          continue;
        }
        let gmeta: GradeMeta;
        try {
          gmeta = JSON.parse(readFileSync(gmetaPath, "utf8")) as GradeMeta;
        } catch {
          failures.push(`${a.candId} rep-${a.rep}: grade ${gid} corrupt (meta.json)`);
          continue;
        }
        if (gmeta.status !== "ok") {
          failures.push(`${a.candId} rep-${a.rep}: grade ${gid} failed — ${gmeta.reason ?? "unknown"}${gmeta.message ? ` (${gmeta.message})` : ""}`);
          continue;
        }
        let parsed: GradeJson;
        try {
          const raw: unknown = JSON.parse(readFileSync(join(revDir, "parsed.json"), "utf8"));
          if (!isRecord(raw) || !isRecord(raw.criteria)) throw new Error("shape");
          parsed = raw as unknown as GradeJson;
        } catch {
          failures.push(`${a.candId} rep-${a.rep}: grade ${gid} corrupt (parsed.json)`);
          continue;
        }
        let protocol: Record<string, unknown>;
        try {
          const raw: unknown = JSON.parse(readFileSync(join(revDir, "input.json"), "utf8"));
          if (!isRecord(raw) || !isRecord(raw.protocol) || !isRecord(raw.protocol.rubric)) throw new Error("shape");
          protocol = raw.protocol;
        } catch {
          failures.push(`${a.candId} rep-${a.rep}: grade ${gid} corrupt (input.json)`);
          continue;
        }
        const protocolKey = hash(JSON.stringify(protocol)).slice(0, 8);
        const rubric = protocol.rubric as Record<string, number>; // shape checked above
        const criteria: Record<string, number> = {};
        for (const [k, val] of Object.entries(parsed.criteria)) if (typeof val === "number") criteria[k] = val;
        const total = Object.values(criteria).reduce((s, n) => s + n, 0);
        const maxTotal = Object.values(rubric).reduce((s, n) => s + (typeof n === "number" ? n : 0), 0);
        const group = groups.get(protocolKey) ?? [];
        group.push({ candidate: a.candId, rep: a.rep, criteria, total, maxTotal, notes: parsed.notes });
        groups.set(protocolKey, group);
      }
      if (groups.size === 0) continue;
      lines.push(`### Grader ${gid}`, "");
      if (groups.size > 1) lines.push("grading protocol changed between grades under this grader — totals across these tables are not comparable", "");
      const jsonGroups: unknown[] = [];
      for (const [protocolKey, rows] of [...groups.entries()].sort(([x], [y]) => cmpStr(x, y))) {
        if (groups.size > 1) lines.push(`Protocol ${protocolKey}:`, "");
        const critNames = [...new Set(rows.flatMap((r) => Object.keys(r.criteria)))].sort(cmpStr);
        lines.push(`| Candidate | Rep | ${critNames.join(" | ")} | Total (max ${rows[0].maxTotal}) |`);
        lines.push(`|${Array(critNames.length + 3).fill("---").join("|")}|`);
        for (const r of rows) {
          lines.push(`| ${r.candidate} | ${r.rep} | ${critNames.map((k) => (k in r.criteria ? String(r.criteria[k]) : "")).join(" | ")} | ${r.total} / ${r.maxTotal} |`);
        }
        lines.push("");
        const noted = rows.filter((r) => r.notes);
        if (noted.length > 0) {
          lines.push(groups.size > 1 ? `Notes (${gid}, protocol ${protocolKey}):` : `Notes (${gid}):`);
          for (const r of noted) lines.push(`- ${r.candidate} rep-${r.rep}: ${mdCell(r.notes as string)}`);
          lines.push("");
        }
        jsonGroups.push({ protocol: protocolKey, rows });
      }
      jsonGraders.push({ grader: gid, groups: jsonGroups });
    }
    for (const a of caseAttempts) {
      if (!a.meta) failures.push(`${a.candId} rep-${a.rep}: interrupted (no meta.json — run was cut off)`);
      else if (a.meta.status !== "ok") failures.push(`${a.candId} rep-${a.rep}: ${a.meta.reason}${a.meta.message ? ` — ${a.meta.message}` : ""}`);
    }
    failures.sort(cmpStr);
    if (failures.length > 0) {
      lines.push("Failures:");
      for (const f of failures) lines.push(`- ${f}`);
      lines.push("");
    }
    jsonOut.push({ case: caseId, graders: jsonGraders, failures });
  }
  writeFileSync(join(results, "tables.md"), lines.join("\n"));
  writeFileSync(join(results, "tables.json"), `${JSON.stringify(jsonOut, null, 2)}\n`);
  console.log(`wrote ${join(results, "tables.md")}`);
}

// --- blind ---------------------------------------------------------------------

function cmdBlind(args: string[]): void {
  const values = opts(args, { results: { type: "string" }, seed: { type: "string" } });
  const results = resolve(need(values.results, "--results"));
  const seed = values.seed ?? "blind";
  const attempts = listAttempts(results).filter((a) => a.meta?.status === "ok");
  const lines: string[] = [
    "# Blind reading",
    "",
    `Labels are anonymized per case from seed "${seed}". Blinding is honor-system: labels are reproducible from the seed and the mapping sits in blind-key.json beside this file — keep the key closed while reading. It hides identities from a cooperative human reader, not from an adversary. Rank the samples per case, then open the key and the tables.`,
    "",
  ];
  const key: Record<string, Record<string, string>> = {};
  for (const caseId of [...new Set(attempts.map((a) => a.caseId))]) {
    const caseAttempts = attempts.filter((a) => a.caseId === caseId);
    const candIds = [...new Set(caseAttempts.map((a) => a.candId))].sort((a, b) => cmpStr(hash(`${seed}:${caseId}:${a}`), hash(`${seed}:${caseId}:${b}`)));
    if (candIds.length > 26) die(`case ${caseId}: blind supports at most 26 candidates`);
    const labels = new Map(candIds.map((cand, i) => [cand, String.fromCharCode(65 + i)]));
    key[caseId] = Object.fromEntries(candIds.map((cand) => [labels.get(cand) as string, cand]));
    lines.push(`## Case ${caseId}`, "");
    const withPrompt = caseAttempts.find((a) => existsSync(join(a.path, "prompt.md")));
    if (withPrompt) lines.push("### Prompt", "", readFileSync(join(withPrompt.path, "prompt.md"), "utf8").trim(), "");
    const reps = [...new Set(caseAttempts.map((a) => a.rep))].sort((x, y) => x - y);
    for (const rep of reps) {
      for (const cand of candIds) {
        const a = caseAttempts.find((x) => x.candId === cand && x.rep === rep);
        if (!a) continue;
        lines.push(`### Sample ${labels.get(cand)} — rep ${rep}`, "");
        // Candidate output is remote-model text: indent it out of markdown's
        // heading/table syntax so a sample cannot forge another sample's
        // section in the human tie-breaker read.
        for (const line of readFileSync(join(a.path, "stdout"), "utf8").trim().split("\n")) lines.push(line ? `    ${line}` : "");
        lines.push("");
      }
    }
  }
  writeFileSync(join(results, "blind.md"), lines.join("\n"));
  writeFileSync(join(results, "blind-key.json"), `${JSON.stringify(key, null, 2)}\n`);
  console.log(`wrote ${join(results, "blind.md")} (+ blind-key.json)`);
}

// --- summarize -------------------------------------------------------------------

async function cmdSummarize(args: string[]): Promise<void> {
  const values = opts(args, { results: { type: "string" }, cmd: { type: "string" }, "timeout-ms": { type: "string" } });
  const results = resolve(need(values.results, "--results"));
  const cmdPath = resolve(need(values.cmd, "--cmd"));
  const timeoutMs = parseCount(values["timeout-ms"] ?? "1800000", "--timeout-ms");
  const raw = loadJson(cmdPath);
  if (!isRecord(raw) || !Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.some((a: unknown) => typeof a !== "string"))
    die(`${cmdPath}: expected {"argv": [...], "cwd"?, "env"?}`);
  if (raw.env !== undefined && (!isRecord(raw.env) || Object.entries(raw.env).some(([k, v]) => typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))))
    die(`${cmdPath}: env must be an object of UPPER_SNAKE string values — declared non-secret overrides only`);
  const tables = join(results, "tables.md");
  if (!existsSync(tables)) die(`run tabulate first: ${tables} missing`);
  const configDir = dirname(cmdPath);
  // Snapshot the summarizer's inputs BEFORE spawning and hand it the
  // snapshots: the summary then provably summarizes the bytes recorded with
  // it, even if tables.md/blind.md change while the summarizer runs.
  const attemptTables = join(results, "summary-attempt-tables.md");
  copyFileSync(tables, attemptTables);
  const map: Record<string, string> = { configDir, tables: attemptTables };
  const blind = join(results, "blind.md");
  let attemptBlind: string | undefined;
  if (existsSync(blind)) {
    attemptBlind = join(results, "summary-attempt-blind.md");
    copyFileSync(blind, attemptBlind);
    map.blind = attemptBlind;
  }
  const argv = subst(raw.argv as string[], map, "summarizer");
  const tooLong = checkArgvBytes(argv);
  if (tooLong) die(tooLong);
  const cwd = typeof raw.cwd === "string" ? resolve(configDir, subst([raw.cwd], map, "summarizer cwd")[0]) : process.cwd();
  if (!existsSync(cwd)) die(`summarizer cwd does not exist: ${cwd}`);
  const start = Date.now();
  const attemptOut = join(results, "summary-attempt.md");
  const attemptErr = join(results, "summary-attempt.stderr");
  const env = resolveEnv(raw.env as Record<string, string> | undefined, map, configDir, "summarizer");
  // The summarizer runs under the same controlled-config discipline as
  // candidates and graders: validated snapshot, private runtime copy.
  const agentConfig = env?.PI_CODING_AGENT_DIR ? snapshotAgentConfig(results, env.PI_CODING_AGENT_DIR, new Map()) : undefined;
  const r = await runControlled(argv, cwd, timeoutMs, attemptOut, attemptErr, env, agentConfig, results);
  const meta = {
    argv,
    cwd,
    ...(env ? { env } : {}),
    ...(agentConfig ? { agentConfig } : {}),
    startedAt: new Date(start).toISOString(),
    durationMs: Date.now() - start,
    exitCode: r.status,
    signal: r.signal,
  };
  if (r.error || r.timedOut || r.signal || r.status !== 0) {
    // The previous successful summary stays exactly where it was; the failed
    // attempt is recorded separately instead of overwriting it.
    const reason = r.error ? String(r.error) : r.timedOut ? `timeout after ${timeoutMs}ms` : r.signal ? `killed by ${r.signal}` : `exit code ${r.status}`;
    writeFileSync(join(results, "summary-failed.meta.json"), `${JSON.stringify({ ...meta, status: "failed", reason }, null, 2)}\n`);
    die(`summarizer failed: ${reason} (previous summary.md preserved; raw attempt in summary-attempt.md, details in summary-failed.meta.json)`);
  }
  const tablesBytes = readFileSync(attemptTables); // the exact bytes the summarizer was fed
  copyFileSync(attemptOut, join(results, "summary.md"));
  writeFileSync(join(results, "summary-tables.md"), tablesBytes);
  let blindMeta: { sha256: string; snapshot: string } | null = null;
  if (attemptBlind) {
    const blindBytes = readFileSync(attemptBlind);
    writeFileSync(join(results, "summary-blind.md"), blindBytes);
    blindMeta = { sha256: hash(blindBytes), snapshot: "summary-blind.md" };
  }
  writeFileSync(
    join(results, "summary.meta.json"),
    `${JSON.stringify({ ...meta, status: "ok", tablesSha256: hash(tablesBytes), tablesSnapshot: "summary-tables.md", blind: blindMeta }, null, 2)}\n`,
  );
  console.log(`wrote ${join(results, "summary.md")}`);
}

const USAGE = `usage:
  node scripts/compare.ts generate  --corpus DIR --candidates FILE --results DIR [--reps N] [--timeout-ms N]
  node scripts/compare.ts grade     --corpus DIR --graders FILE --results DIR [--timeout-ms N]
  node scripts/compare.ts tabulate  --results DIR
  node scripts/compare.ts blind     --results DIR [--seed S]
  node scripts/compare.ts summarize --results DIR --cmd FILE [--timeout-ms N]
see docs/model-comparison.md`;

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "generate":
    await cmdGenerate(rest);
    break;
  case "grade":
    await cmdGrade(rest);
    break;
  case "tabulate":
    cmdTabulate(rest);
    break;
  case "blind":
    cmdBlind(rest);
    break;
  case "summarize":
    await cmdSummarize(rest);
    break;
  default:
    console.error(USAGE);
    process.exit(2);
}
