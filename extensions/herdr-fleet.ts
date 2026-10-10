// herdr-fleet.ts — herdr-native fleet UX.
//   /fleet                  compact status surface: named agents + live state + owner [mine]/[yours] (zero-token)
//   /delegate <name> <task> spawn a named pi in a new tab of THIS workspace, hand it the task; refuses without an `Owner outcome:` block
//   /ws [repo|dir] <purpose> new focused workspace: dir from identifier or the model's read of the purpose; name from purpose; repo ids from `configs/ws.json`
// Delegated pane agents are first-class: they join intercom under their herdr name,
// and you talk to them by focusing their pane (herdr agent focus <name>).
import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeContext, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, realpathSync } from "node:fs";
import { resolve, join, isAbsolute, basename, dirname } from "node:path";
import { claimWriter, createWorktree, gitOutput, readWriterClaim, removeWriterClaim, withWriterOperation, worktreeDestination, worktreeIdentity, writerClaimPath, type Worktree, type WriterClaim } from "./lib/worktree.ts";

// This session's pi-intercom ID — what a child must report to, because names change and IDs do not
// (pi-subagents src/pi-intercom/index.ts L1284 at the pinned 84614b3: `pi-` + sha256(sessionId).hex[0:32]).
// Same one line as in pr-review.ts on purpose: not worth a shared module.
const intercomId = (sessionId: string) => `pi-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;

// The herdr skill forbids inspect/control from outside Herdr; every command's execs route through herdr().
function assertHerdr() {
  if (process.env.HERDR_ENV !== "1") throw new Error("not running inside Herdr (HERDR_ENV is not 1)");
}

function assertPaneLaunch() {
  assertHerdr();
  if (process.env.PI_SUBAGENT_CHILD === "1") throw new Error("headless leaf subagents cannot launch pane agents");
}

async function herdr(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<unknown> {
  assertHerdr();
  signal?.throwIfAborted();
  const r = await pi.exec("herdr", args, { signal });
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

// herdr --skill: agent names must match [a-z][a-z0-9_-]{0,31} and be unique among live agents.
const LEGAL_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

// Directory from an explicit identifier (path or configured repo id as first word) or, failing that,
// the session model's read of the purpose. Name is model-derived either way unless already a slug.
async function planWorkspace(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<WsPlan> {
  const [first = "", ...restWords] = args.split(/\s+/).filter(Boolean);
  let dir: string | undefined;
  let hint = args;
  const expanded = first.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
  const repos = repoMap();
  if (first && repos[first]) dir = isAbsolute(repos[first]) ? repos[first] : resolve(executionCwd(pi, ctx), repos[first]);
  else if (first) {
    let explicit: string | undefined;
    if (isAbsolute(expanded)) explicit = expanded;
    else {
      try {
        explicit = resolve(executionCwd(pi, ctx), expanded);
      } catch {
        // This speculative directory probe may fall back to model-selected repo prose.
      }
    }
    if (explicit && existsSync(explicit) && statSync(explicit).isDirectory()) dir = realpathSync.native(explicit);
  }
  if (dir) hint = restWords.join(" ");
  if (dir && LEGAL_NAME.test(hint)) return { name: hint, dir }; // slug + dir: no model call
  // A single-token hint beside an explicit dir/repo is a requested name, not a purpose: never
  // silently replace an illegal one with a model-invented one. Multi-word hints stay purposes.
  if (dir && hint && !hint.includes(" ")) {
    throw new Error(`illegal agent name "${hint}" — must match [a-z][a-z0-9_-]{0,31} (start with a letter, ≤32 chars); give a multi-word purpose to have the model choose`);
  }

  let source = hint;
  if (!source) {
    const users = ctx.sessionManager
      .getBranch()
      .flatMap((e) => {
        if (e.type !== "message" || e.message.role !== "user") return [];
        const c = e.message.content;
        return [typeof c === "string" ? c : c.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")];
      })
      .slice(-3);
    source = users.join("\n---\n").slice(-4000);
  }
  if (!source.trim()) throw new Error("nothing to plan from — /ws [repo|dir] <purpose>");
  const repoIds = Object.keys(repos);
  if (!dir && repoIds.length === 0) throw new Error(`no repos configured — add {"repos": {"<id>": "<path>"}} to ${wsConfigPath()} or /ws <dir> <purpose>`);
  const model = ctx.model;
  if (!model) throw new Error("no model selected");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error(`no provider ${model.provider}`);
  // normalizeContext folds the planning persona into a leading system message — a raw
  // { systemPrompt } field is not a TranscriptContext and the provider drops it silently.
  // stream, not streamSimple: its reasoning option would newly enable thinking here.
  const r = await provider
    .stream(
      model,
      normalizeContext({ systemPrompt: PLAN_RULE(repoIds), messages: [{ role: "user", content: [{ type: "text", text: source }], timestamp: Date.now() }] }),
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env }
    )
    .result();
  if (r.stopReason === "error") throw new Error(r.errorMessage ?? "planning call failed");
  const text = r.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`model returned no plan: ${JSON.stringify(text)}`);
  const plan = JSON.parse(json) as { name?: string; repo?: string | null };
  const name = String(plan.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "") // herdr names start with a letter
    .slice(0, 32);
  if (!name) throw new Error(`model returned no usable name: ${json}`);
  if (!dir) {
    if (!plan.repo || !repos[plan.repo]) throw new Error(`can't tell which repo — /ws <repo> ${hint}`);
    dir = repos[plan.repo];
  }
  return { name, dir };
}

const ICON: Record<string, string> = { working: "⚙", idle: "○", done: "✓" };
const RANK: Record<string, number> = { working: 0, idle: 1, done: 2 };

interface FleetAgent {
  name?: string;
  cwd?: string;
  pane_id?: string;
  focused?: boolean;
  agent_status?: string;
  workspace_id?: string;
  foreground_cwd?: string;
  agent_session?: { kind: string; value: string };
}

async function agentList(pi: ExtensionAPI, signal?: AbortSignal): Promise<FleetAgent[]> {
  const result = await herdr(pi, ["agent", "list"], signal) as { agents?: FleetAgent[] };
  if (!Array.isArray(result.agents)) throw new Error("Native agent list is unavailable; state is unknown");
  return result.agents;
}

// Workspace membership selects launch topology, never ownership.
function myWorkspace(agents: FleetAgent[]): string | undefined {
  const pane = process.env.HERDR_PANE_ID;
  return pane ? agents.find((a) => a.pane_id === pane)?.workspace_id : undefined;
}

// herdr agent names are unique per server and double as intercom addresses: suffix on collision,
// truncating the base so the suffixed name still fits the 32-char limit.
function uniqueName(name: string, agents: FleetAgent[], role?: Role): string {
  const taken = new Set(agents.map((a) => a.name));
  const purpose = role === "coordinator"
    ? name.replace(/(^|[-_])coordinator(?=$|[-_])/g, "").replace(/^[-_]+|[-_]+$/g, "")
    : name;
  // A legal incoming coordinator-3d-print must not become an illegal digit-led name.
  const leadingRole = role === "coordinator" && purpose && !/^[a-z]/.test(purpose) ? "coordinator-" : "";
  const suffix = role === "coordinator" && !leadingRole ? (purpose ? "-coordinator" : "coordinator") : "";
  for (let i = 1; ; i++) {
    const collision = i === 1 ? "" : `-${i}`;
    const prefix = purpose.slice(0, 32 - leadingRole.length - suffix.length - collision.length);
    const label = `${leadingRole}${role === "coordinator" ? prefix.replace(/[-_]+$/, "") : prefix}${suffix}${collision}`;
    if (!taken.has(label)) return label;
  }
}

// The name herdr is asked to create: collision-suffixed, then re-validated at the creation
// boundary — an illegal name must never reach tab/workspace create whatever the upstream path.
function finalName(base: string, agents: FleetAgent[], role?: Role): string {
  const name = uniqueName(base, agents, role);
  if (!LEGAL_NAME.test(name)) throw new Error(`illegal agent name "${name}" — must match [a-z][a-z0-9_-]{0,31}`);
  return name;
}

// A failed agent start/prompt can leave a live child (agent_not_ready keeps the name; a stalled
// prompt may still have been delivered). A listed name can be claimed by someone else before our
// start, so inspection targets the returned pane ID, not the name. No auto-retry, no closing.
async function agentOp(pi: ExtensionAPI, args: string[], name: string, paneId: string, signal?: AbortSignal): Promise<unknown> {
  try {
    return await herdr(pi, args, signal);
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : String(e)} — ${name} (pane ${paneId}) may be live: ` +
        `inspect with \`herdr agent get ${paneId}\` and \`herdr agent read ${paneId} --source recent-unwrapped --lines 120\`; ` +
        "a timeout or stall is not proof of non-delivery — do not resubmit blindly"
    );
  }
}

// Every delegated task must carry the owner's verbatim ask so intent survives every hop
// (coordinator → implementer → reviewer). Paraphrased design briefs are how a one-line fix
// became a 1,200-line rewrite (staging-deploy-triage post-mortem, 2026-09-14).
const OWNER_OUTCOME = /^Owner outcome:/m;

// Appended to every delegated task: the child's contract with its spawner (addressed by intercom ID).
const CONTRACT = (me: string, name: string) =>
  `You were spawned by intercom session \`${me}\`. The \`Owner outcome:\` block above is the user's verbatim ask and the only authority on intent; everything else in this brief is your spawner's derived design and may be wrong — if the two conflict, follow the owner outcome and tell \`${me}\`. Copy the \`Owner outcome:\` block unchanged into every subagent brief you write (reviewer included). When done, report ONCE to intercom session \`${me}\` (that is your spawner's ID; use it verbatim) as one line: ✅ ${name} — <outcome>. Then close your own tab: \`herdr tab close "$HERDR_TAB_ID"\`.`;

type Role = "coordinator" | "coder";
type Mode = "interactive" | "delegated";
interface RoleProfile { model: string; thinking: string; instructionsFile: string }
interface LaunchRequest { name: string; task: string; role?: Role; mode?: "delegated"; cwd?: string; base?: string; noProjectResources?: boolean }

interface LaunchRecord {
  ownerSessionId: string;
  ownerSessionFile?: string;
  childSessionId: string;
  launchId: string;
  name: string;
  role: Role;
  phase: string;
  sourceCwd: string;
  cwd: string;
  branch?: string | null;
  base?: string;
  baseCommit?: string;
  worktreeKey?: string;
  claimHash?: string;
  paneId?: string;
  error?: string;
}

function nativeOwnerFile(ctx: ExtensionContext): string | undefined {
  const path = ctx.sessionManager.getSessionFile();
  if (path === undefined) return undefined;
  if (!isAbsolute(path) || hasControls(path)) throw new Error("Native parent session-file path is invalid; use a persistent Pi session");
  const canonical = existsSync(path) ? realpathSync.native(path) : join(realpathSync.native(dirname(path)), basename(path));
  if (hasControls(canonical)) throw new Error("Native parent session-file path contains control characters");
  return canonical;
}

function ownLaunches(ctx: ExtensionContext): LaunchRecord[] {
  const records = new Map<string, LaunchRecord>();
  const ownerFile = nativeOwnerFile(ctx);
  if (!ownerFile) return [];
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== "fleet-launch" || !entry.data || typeof entry.data !== "object") continue;
    const record = entry.data as LaunchRecord;
    if (record.ownerSessionId === ctx.sessionManager.getSessionId() && record.ownerSessionFile === ownerFile && typeof record.launchId === "string") records.set(record.launchId, record);
  }
  return [...records.values()];
}

function sessionMatches(ref: FleetAgent["agent_session"], childId: string): boolean {
  return ref?.kind === "id" ? ref.value === childId
    : ref?.kind === "path" && isAbsolute(ref.value) && basename(ref.value).endsWith(`_${childId}.jsonl`);
}

function verifySessionHeader(ref: FleetAgent["agent_session"], record: LaunchRecord) {
  if (!sessionMatches(ref, record.childSessionId)) throw new Error("Native child session identity is missing or mismatched");
  if (ref?.kind !== "path" || !existsSync(ref.value)) return; // Native files are lazy until the first user message.
  const fd = openSync(ref.value, "r");
  const buffer = Buffer.alloc(8192);
  let header: unknown;
  try { header = JSON.parse(buffer.subarray(0, readSync(fd, buffer)).toString("utf8").split("\n")[0]); }
  finally { closeSync(fd); }
  if (!header || typeof header !== "object") throw new Error("Invalid native child session header");
  const data = header as Record<string, unknown>;
  if (data.type !== "session" || data.id !== record.childSessionId || typeof data.cwd !== "string" || realpathSync.native(data.cwd) !== record.cwd) {
    throw new Error("Native child session header does not match this launch");
  }
}

async function sameTreeOccupants(pi: ExtensionAPI, agents: FleetAgent[], worktree: Worktree, signal?: AbortSignal) {
  const occupants: FleetAgent[] = [];
  for (const agent of agents) {
    if (agent.pane_id === process.env.HERDR_PANE_ID) continue;
    for (const cwd of new Set([agent.cwd, agent.foreground_cwd])) {
      if (!cwd) continue;
      let key: string;
      try { key = realpathSync.native(await gitOutput(pi, cwd, ["rev-parse", "--absolute-git-dir"], signal)); }
      catch {
        signal?.throwIfAborted();
        continue; // Non-Git or vanished paths are not observed same-tree occupancy.
      }
      if (key === worktree.key) { occupants.push(agent); break; }
    }
  }
  return occupants;
}

// eslint-disable-next-line no-control-regex -- Mirrors herdr's control-character rejection at the argv boundary.
const hasControls = (value: string) => /[\u0000-\u001f\u007f-\u009f]/.test(value);

function roleProfile(role: Role): RoleProfile {
  const path = join(getAgentDir(), "configs/session-roles.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const profile = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[role] : undefined;
  if (!profile || typeof profile !== "object") throw new Error(`missing ${role} profile in ${path}`);
  const { model, thinking, instructionsFile } = profile as Record<string, unknown>;
  if (typeof model !== "string" || hasControls(model) || !/^[a-z0-9][a-z0-9._-]*\/\S+$/.test(model)) {
    throw new Error(`${path}: ${role}.model must be a qualified provider/model ID`);
  }
  if (typeof thinking !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
    throw new Error(`${path}: ${role}.thinking is invalid`);
  }
  if (typeof instructionsFile !== "string" || !instructionsFile.trim() || hasControls(instructionsFile)) {
    throw new Error(`${path}: ${role}.instructionsFile must name a role instruction file`);
  }
  const file = resolve(getAgentDir(), "configs", instructionsFile);
  if (hasControls(file) || !readFileSync(file, "utf8").trim()) throw new Error(`${path}: ${role} instruction file must be nonempty and have a control-free path`);
  return { model, thinking, instructionsFile: file };
}

// change_dir keeps session resources and ctx.cwd unchanged. Ask its synchronous
// event owner for the execution directory; never guess from process.cwd().
function executionCwd(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const request: { sessionManager: ExtensionContext["sessionManager"]; result?: { cwd?: unknown; error?: unknown } } = {
    sessionManager: ctx.sessionManager,
  };
  pi.events.emit("pi-change-working-dir:resolve-execution-cwd", request);
  if (request.result !== undefined) {
    const result = request.result;
    if (!result || typeof result !== "object") throw new Error("invalid execution directory from change_dir");
    if (result.error !== undefined) {
      throw new Error(typeof result.error === "string" && result.error ? result.error : "invalid execution directory error from change_dir");
    }
    if (typeof result.cwd !== "string" || !isAbsolute(result.cwd) || hasControls(result.cwd)) {
      throw new Error("invalid execution directory from change_dir");
    }
    return result.cwd;
  }
  if (pi.getAllTools().some((tool) => tool.name === "change_dir")) {
    throw new Error("change_dir cannot resolve its execution directory; update the extension and restart Pi before launching");
  }
  return ctx.cwd;
}

function launchDirectory(pi: ExtensionAPI, ctx: ExtensionContext, requested?: string): string {
  if (requested !== undefined && (typeof requested !== "string" || !requested.trim() || hasControls(requested))) {
    throw new Error("cwd must be a nonempty directory path without control characters");
  }
  const expanded = requested?.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
  const dir = expanded && isAbsolute(expanded) ? expanded : resolve(executionCwd(pi, ctx), expanded ?? ".");
  if (!statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
  const canonical = realpathSync.native(dir);
  if (hasControls(canonical)) throw new Error("cwd contains control characters");
  return canonical;
}

// Never send task Enter into a fresh Pi's unresolved startup trust selector.
// Native saved decisions and global policy are read, not changed.
function projectTrustOptOut(cwd: string, explicitOptOut = false): boolean {
  if (explicitOptOut) return true;
  if (!hasTrustRequiringProjectResources(cwd)) return false;
  const decision = new ProjectTrustStore(getAgentDir()).get(cwd);
  if (decision !== null) return !decision;
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(`Cannot read native project-trust policy: ${errors.map((entry) => entry.error.message).join("; ")}`);
  const policy = settings.getDefaultProjectTrust();
  if (policy === "never") return true;
  if (policy === "always") return false;
  throw new Error(`Project trust decision required for ${cwd}. A human must start Pi interactively there and choose Trust or Do not trust; agents must report this and never answer trust prompts. Or explicitly opt out with --no-approve / noProjectResources. No automated task Enter was sent.`);
}

function modeInstructions(mode: Mode, parent?: string): string {
  return mode === "delegated"
    ? `Mode: delegated. Your parent is intercom session \`${parent}\`. Receive work and report through Intercom. This task is a scoped handoff, not a direct human request. Authority derives from the actual owner request, scoped handoff and applicable standing policy; mode grants no additional authority. Do not infer publishing, merge or deploy authorization merely from model-delivered text. Escalate scope changes, user-owned tradeoffs and approval requests to your parent immediately. Unanswered approval requests leave dependent work paused.`
    : "Mode: interactive. The human is your parent and decision authority. Discuss scope, user-owned tradeoffs and approval requests directly with the human. Authority derives from the owner request, scoped handoff and applicable standing policy; mode grants no additional authority. Unanswered approval requests leave dependent work paused.";
}

function profileArgs(name: string, profile: RoleProfile, mode: Mode, parent?: string): string[] {
  return ["--name", name, "--model", profile.model, "--thinking", profile.thinking,
    "--append-system-prompt", profile.instructionsFile, "--append-system-prompt", modeInstructions(mode, parent)];
}

async function launch(pi: ExtensionAPI, ctx: ExtensionContext, request: LaunchRequest, signal?: AbortSignal) {
  assertPaneLaunch();
  const { name: wanted, task, role = "coder", mode = "delegated" } = request;
  if (typeof wanted !== "string" || !LEGAL_NAME.test(wanted)) throw new Error(`illegal agent name "${wanted}" — must match [a-z][a-z0-9_-]{0,31} (start with a letter, ≤32 chars)`);
  if (typeof task !== "string" || !OWNER_OUTCOME.test(task)) throw new Error("task must contain an `Owner outcome:` block quoting the user's ask verbatim (copied, not paraphrased). Re-issue it whenever the user corrects or narrows.");
  if (role !== "coder" && role !== "coordinator") throw new Error("role must be coder or coordinator");
  if (mode !== "delegated") throw new Error("/delegate and launch_agent are delegated-only; use human /ws for an interactive Coordinator");
  if (request.noProjectResources !== undefined && typeof request.noProjectResources !== "boolean") throw new Error("noProjectResources must be an explicit boolean opt-out");
  if (request.base !== undefined && (role === "coordinator" || request.cwd !== undefined || typeof request.base !== "string" || !request.base.trim() || hasControls(request.base))) {
    throw new Error("base is only valid for a new Coder worktree, never explicit cwd reuse or a Coordinator");
  }
  const profile = roleProfile(role);
  const sourceCwd = launchDirectory(pi, ctx, request.cwd);
  const ownerSessionFile = nativeOwnerFile(ctx);
  if (role === "coder" && !ownerSessionFile) throw new Error("Coder launch needs a persistent native parent session. Start Pi without --no-session (or use a persisted SDK SessionManager), then reissue the task. No Git, pane or claim was created.");
  if (role === "coordinator") projectTrustOptOut(sourceCwd, request.noProjectResources);
  const parent = intercomId(ctx.sessionManager.getSessionId());
  const agents = await agentList(pi, signal);
  const ws = myWorkspace(agents);
  if (!ws) throw new Error("/delegate needs to run inside a herdr pane");
  const name = finalName(wanted, agents, role);
  let record: LaunchRecord = { ownerSessionId: ctx.sessionManager.getSessionId(), ownerSessionFile, childSessionId: randomUUID(), launchId: randomUUID(), name, role, phase: "intent", sourceCwd, cwd: sourceCwd };
  const save = (phase: string, update: Partial<LaunchRecord> = {}) => {
    record = { ...record, ...update, phase };
    pi.appendEntry("fleet-launch", record);
  };
  let tabAttempted = false;
  let claimAttempted = false;
  const inspect = () => {
    if (!tabAttempted && record.claimHash && record.worktreeKey) {
      return `launch ${record.launchId}, cwd ${record.cwd}, branch ${record.branch}, base ${record.baseCommit}. Claim ${join(record.worktreeKey, "pawprint-writer.json")} is retained. No pane was attempted and no task was delivered. First call release_worktree(${JSON.stringify({ cwd: record.cwd })}) or /release-worktree ${JSON.stringify(record.cwd)} from this UUID/file-bound parent; only after successful release, resolve native trust or explicitly opt out. Exit any Pi opened to resolve trust before relaunching with this exact cwd. Do not remove Git state or retry automatically.`;
    }
    if (claimAttempted && !record.claimHash && record.worktreeKey) return `Writer claim creation/write/readback was attempted at ${join(record.worktreeKey, "pawprint-writer.json")}; state is uncertain. Keep any file there and inspect it. No pane was attempted or task delivered. Do not delete, release or retry automatically.`;
    if (!tabAttempted && !record.base) return `No Git worktree, pane or writer claim was created by this attempt. Correct the refusal before relaunching.`;
    return `launch ${record.launchId}, cwd ${record.cwd}, branch ${record.branch ?? "unchanged"}, base ${record.baseCommit ?? "unchanged"}, Git dir ${record.worktreeKey ?? "not yet known"}${record.paneId ? `, pane ${record.paneId}` : ""}. Inspect \`git -C '${sourceCwd.replace(/'/g, "'\\''")}' worktree list --porcelain\`, destination contents and branch refs${record.paneId ? `; \`herdr agent get ${record.paneId}\` and \`herdr agent read ${record.paneId} --source recent-unwrapped --lines 120\`` : tabAttempted ? `; inspect tabs in ${ws}` : ""}. Keep partial state; do not retry or remove it automatically.`;
  };
  const runPane = async () => {
    const cwd = record.cwd;
    const optOut = projectTrustOptOut(cwd, request.noProjectResources);
    save("tab-requested");
    tabAttempted = true;
    const tabArgs = ["tab", "create", "--workspace", ws, "--cwd", cwd, "--label", name, "--no-focus", "--env", `PI_CODING_AGENT_DIR=${getAgentDir()}`, "--env", `PI_SPAWNED_BY=${parent}`];
    const tab = await herdr(pi, tabArgs, signal);
    const paneId = findPaneId(tab);
    if (!paneId) throw new Error(`tab created but no pane_id in response; inspect tabs in ${ws} before retrying`);
    save("tab", { paneId });
    await agentOp(pi, ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", "--session-id", record.childSessionId,
      ...profileArgs(name, profile, mode, parent), ...(optOut ? ["--no-approve"] : [])], name, paneId, signal);
    try {
      if (projectTrustOptOut(cwd, request.noProjectResources) !== optOut) throw new Error("Native project-trust decision changed during launch");
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Keep pane ${paneId}. A human must inspect with \`herdr agent get ${paneId}\` and focus with \`herdr agent focus ${paneId}\`, resolve any native trust prompt, confirm Pi is running and its editor is ready, then paste the original task into the Pi editor, never into a shell. Agents must report this and never answer trust prompts. No task was delivered. Do not retry the launcher.`);
    }
    const native = await herdr(pi, ["agent", "get", paneId], signal) as { agent?: FleetAgent };
    verifySessionHeader(native.agent?.agent_session, record);
    save("started");
    await agentOp(pi, ["agent", "prompt", paneId, `${task}\n\n${CONTRACT(parent, name)}`, "--wait", "--until", "working", "--timeout", "10000"], name, paneId, signal);
    verifySessionHeader(native.agent?.agent_session, record);
    save("prompted");
    return { name, paneId, role, mode, cwd, sourceCwd, parent, model: profile.model, thinking: profile.thinking,
      ownerSessionId: record.ownerSessionId, ownerSessionFile: record.ownerSessionFile, childSessionId: record.childSessionId, launchId: record.launchId, branch: record.branch, base: record.base, baseCommit: record.baseCommit,
      worktreeKey: record.worktreeKey, claimPath: record.worktreeKey ? join(record.worktreeKey, "pawprint-writer.json") : undefined };
  };
  try {
    if (role === "coordinator") { save("intent"); return await runPane(); }
    if (!ownerSessionFile) throw new Error("Coder launch needs a persistent native parent session");
    let tree = await worktreeIdentity(pi, sourceCwd, signal);
    if (request.cwd !== undefined) {
      if (tree.key === tree.common) throw new Error("Explicit Coder cwd must be a linked task worktree, not a primary checkout");
      save("intent", { worktreeKey: tree.key, branch: tree.branch, baseCommit: tree.commit });
    } else {
      const base = request.base ?? "HEAD";
      const commit = await gitOutput(pi, sourceCwd, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], signal);
      const destination = worktreeDestination(tree, name, record.launchId);
      save("git-requested", { ...destination, base, baseCommit: commit });
      tree = await createWorktree(pi, tree, destination, commit, signal);
      save("worktree", { worktreeKey: tree.key });
    }
    return await withWriterOperation(tree, async () => {
      const current = await worktreeIdentity(pi, record.cwd, signal);
      if (current.key !== tree.key) throw new Error("Worktree identity changed during admission");
      const existing = readWriterClaim(tree);
      if (existing) throw new Error(`Worktree already claimed by session ${existing.claim.ownerSessionId}, launch ${existing.claim.launchId}. Keep and inspect ${writerClaimPath(tree)}.`);
      if (request.cwd !== undefined) {
        const occupants = await sameTreeOccupants(pi, await agentList(pi, signal), tree, signal);
        if (occupants.length) throw new Error(`Worktree is occupied by ${occupants.map((a) => a.name ?? a.pane_id ?? "an unowned session").join(", ")}. Refusing explicit reuse; omit cwd for fresh isolation. Occupancy does not prove writer status.`);
      }
      const claim: WriterClaim = { version: 1, ownerSessionId: record.ownerSessionId, ownerSessionFile, childSessionId: record.childSessionId, launchId: record.launchId,
        worktreeKey: tree.key, cwd: record.cwd, branch: tree.branch, baseCommit: tree.commit };
      claimAttempted = true;
      save("claimed", { claimHash: claimWriter(tree, claim) });
      return runPane();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    save(tabAttempted ? "uncertain" : "failed-before-pane", { error: message });
    throw new Error(`${message} — ${inspect()}`);
  }
}

function parseDelegate(args: string): LaunchRequest {
  const options: { role?: Role; mode?: "delegated"; cwd?: string; base?: string; noProjectResources?: boolean } = {};
  let rest = args.trim();
  while (rest.startsWith("--")) {
    if (/^--no-approve(?:\s+|$)/.test(rest)) {
      options.noProjectResources = true;
      rest = rest.replace(/^--no-approve(?:\s+|$)/, "");
      continue;
    }
    const option = rest.match(/^--(role|mode|cwd|base)\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+|$)/);
    if (!option) throw new Error("Usage: /delegate [--role coder|coordinator] [--cwd <existing-worktree> | --base <ref>] [--no-approve] <name> <task>");
    const value = option[2] ?? option[3] ?? option[4];
    if (option[1] === "role") options.role = value as Role;
    else if (option[1] === "mode") {
      if (value !== "delegated") throw new Error("/delegate is delegated-only; use /ws for an interactive Coordinator");
      options.mode = value;
    }
    else if (option[1] === "base") options.base = value;
    else options.cwd = value;
    rest = rest.slice(option[0].length);
  }
  const parts = rest.match(/^(\S+)\s+([\s\S]+)$/);
  if (!parts) throw new Error("Usage: /delegate <name> <task>");
  return { ...options, name: parts[1], task: parts[2] };
}

async function releaseWorktree(pi: ExtensionAPI, ctx: ExtensionContext, requested: string, signal?: AbortSignal) {
  assertPaneLaunch();
  const cwd = launchDirectory(pi, ctx, requested);
  const tree = await worktreeIdentity(pi, cwd, signal);
  if (tree.key === tree.common) throw new Error("Only a linked task worktree can have its writer claim released");
  return withWriterOperation(tree, async () => {
    const stored = readWriterClaim(tree);
    if (!stored) throw new Error(`No writer claim at ${writerClaimPath(tree)}`);
    const claim = stored.claim;
    if (claim.ownerSessionId !== ctx.sessionManager.getSessionId() || claim.ownerSessionFile !== nativeOwnerFile(ctx)) throw new Error("Only the UUID and canonical-file-bound owner session may release this claim; copied or moved session files grant no ownership");
    const record = ownLaunches(ctx).find((r) => r.launchId === claim.launchId && r.childSessionId === claim.childSessionId && r.worktreeKey === tree.key && r.claimHash === stored.hash);
    if (!record) throw new Error("Native launch ownership is uncertain; keep the claim");
    if (record.phase !== "failed-before-pane" || record.paneId) throw new Error("Post-start or uncertain writer claims stay held: pane absence cannot prove detached workers stopped. Completed Coder worktrees cannot be reassigned through the launcher yet. Use fresh isolation; do not remove the claim. Post-start reconciliation/release is deferred.");
    const agents = await agentList(pi, signal);
    if (agents.some((a) => typeof a.pane_id !== "string")) throw new Error("Native agent identity is incomplete; keep the claim");
    if (agents.some((a) => sessionMatches(a.agent_session, claim.childSessionId))) throw new Error("An associated child was observed despite the pre-pane failure record; keep the claim");
    const occupants = await sameTreeOccupants(pi, agents, tree, signal);
    if (occupants.length) throw new Error(`Worktree still occupied by ${occupants.map((a) => a.name ?? a.pane_id).join(", ")}; keep the claim`);
    const current = await worktreeIdentity(pi, cwd, signal);
    if (current.key !== tree.key) throw new Error("Worktree identity changed during release; keep the claim");
    signal?.throwIfAborted();
    removeWriterClaim(tree, stored.hash);
    pi.appendEntry("fleet-launch", { ...record, phase: "released" });
    return { cwd, launchId: claim.launchId, branch: claim.branch, claimPath: writerClaimPath(tree) };
  });
}

export default function herdrFleet(pi: ExtensionAPI) {
  pi.registerCommand("fleet", {
    description: "Fleet status surface: herdr agents with live state",
    handler: async (_args, ctx) => {
      try {
        const agents = await agentList(pi);
        if (agents.length === 0) {
          ctx.ui.notify("No herdr agents found.", "info");
          return;
        }
        agents.sort(
          (a, b) => (RANK[a.agent_status ?? ""] ?? 3) - (RANK[b.agent_status ?? ""] ?? 3)
        );
        const launches = ownLaunches(ctx);
        const lines = agents.map((a) => {
          const name = a.name ?? a.cwd?.split("/").pop() ?? a.pane_id ?? "?";
          const cwd = (a.cwd ?? "").replace(process.env.HOME ?? "", "~");
          const mine = launches.some((record) => record.phase !== "released" && record.paneId === a.pane_id && sessionMatches(a.agent_session, record.childSessionId));
          const owner = mine ? "[mine]" : "[yours]";
          return `${a.focused ? "→" : " "} ${ICON[a.agent_status ?? ""] ?? "?"} ${name}  ${cwd}  ${owner}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (e) {
        ctx.ui.notify(`fleet: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("delegate", {
    description:
      "Launch a delegated Coder in a fresh worktree: /delegate [--base <ref> | --cwd <existing-linked-worktree>] [--no-approve] <name> <task>. Requires Owner outcome. --role coordinator keeps directory behavior; /ws is interactive.",
    handler: async (args, ctx) => {
      try {
        const result = await launch(pi, ctx, parseDelegate(args), ctx.signal);
        ctx.ui.notify(
          `🐑 ${result.name} delegated — ${result.role}/${result.mode}, ${result.model}/${result.thinking} in ${result.cwd}${result.branch ? `; branch ${result.branch}, base ${result.baseCommit}` : ""}; \`herdr agent focus ${result.name}\` to watch. Fresh Pi uses that directory's resources and project-trust checks.`,
          "info"
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(message.startsWith("Usage:") ? message : `delegate: ${message}`, "error");
      }
    },
  });

  if (process.env.PI_SUBAGENT_CHILD !== "1") pi.registerTool({
    name: "launch_agent",
    label: "Launch Pane Agent",
    description: "Launch an isolated Coder or a Coordinator in a no-focus herdr tab.",
    promptSnippet: "Launch an independently owned pane workstream with an explicit role profile",
    promptGuidelines: [
      "Use launch_agent for pane workstreams; delegate runs headless subagents.",
      "Coders default to a fresh linked worktree from the effective repository and committed HEAD. Supply base for repo policy (pawprint: origin/main). Explicit cwd reuses exactly an admitted linked checkout; never combine cwd and base. Coordinators keep directory behavior and reject base.",
      "launch_agent is delegated-only, retains parent provenance and requires the verbatim Owner outcome. Unresolved project trust requires human action; noProjectResources explicitly opts out.",
      "Isolate independent workstreams. Sequence work that depends on an unsettled API or migration. Coder parents need persistent native session files. Release only recorded pre-pane failures through release_worktree. Any pane/start attempt or uncertainty keeps the claim; completed Coder worktrees cannot be reassigned through this launcher yet. Post-start reconciliation/release is deferred. Release never cleans Git.",
      "Never retry launch_agent blindly after an uncertain start or delivery; inspect the returned pane first.",
    ],
    parameters: Type.Object({
      name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" }),
      task: Type.String({ minLength: 1, description: "Task containing the verbatim Owner outcome: block" }),
      role: Type.Optional(StringEnum(["coder", "coordinator"] as const)),
      mode: Type.Optional(StringEnum(["delegated"] as const)),
      cwd: Type.Optional(Type.String({ minLength: 1, description: "Existing linked Coder worktree/subdirectory to reuse exactly; relative to effective cwd, supports ~. Coordinator directory is unchanged." })),
      base: Type.Optional(Type.String({ minLength: 1, description: "Committed base ref for a new Coder worktree; defaults HEAD. Pawprint callers supply origin/main. Invalid with cwd or Coordinator." })),
      noProjectResources: Type.Optional(Type.Boolean({ description: "Explicitly decline trust-gated project resources for this child (--no-approve)" })),
    }, { additionalProperties: false }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await launch(pi, ctx, params, signal);
      return {
        content: [{ type: "text", text: `Launched ${result.name}: ${result.role}/${result.mode}, ${result.model}/${result.thinking}, pane ${result.paneId}, cwd ${result.cwd}, launch ${result.launchId}${result.branch ? `, branch ${result.branch}, base ${result.baseCommit}` : ""}.${result.base ? " Source edits were not transferred." : ""} Fresh Pi uses the resulting directory's resources and project-trust checks.` }],
        details: result,
      };
    },
  });

  pi.registerCommand("release-worktree", {
    description: "Release only your recorded pre-pane failure claim: /release-worktree <cwd>. Post-start/uncertain claims remain held; leaves worktree and branch intact.",
    handler: async (args, ctx) => {
      try {
        if (!args.trim()) throw new Error("Usage: /release-worktree <cwd>");
        const cwd = args.trim().replace(/^(["'])(.*)\1$/, "$2");
        const result = await releaseWorktree(pi, ctx, cwd, ctx.signal);
        ctx.ui.notify(`Released pre-pane failure claim for ${result.cwd}, launch ${result.launchId}. Worktree and branch remain.`, "info");
      } catch (error) {
        ctx.ui.notify(`release-worktree: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  if (process.env.PI_SUBAGENT_CHILD !== "1") pi.registerTool({
    name: "release_worktree",
    label: "Release Worktree Claim",
    description: "Release only a recorded pre-pane failure claim owned by your native UUID and canonical session file. Any pane/start attempt or uncertainty stays claimed because detached workers may remain. Completed Coder worktrees cannot be reassigned yet; post-start reconciliation/release is deferred. No Git cleanup.",
    parameters: Type.Object({ cwd: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await releaseWorktree(pi, ctx, params.cwd, signal);
      return { content: [{ type: "text", text: `Released pre-pane failure claim for ${result.cwd}, launch ${result.launchId}. Worktree and branch remain.` }], details: result };
    },
  });

  pi.registerCommand("ws", {
    description:
      "New focused herdr workspace running pi: /ws [repo|dir] <purpose> — directory from the identifier or inferred from the purpose (repos listed in configs/ws.json); name from the purpose (or this session's recent context)",
    handler: async (args, ctx) => {
      try {
        assertPaneLaunch(); // before planWorkspace can spend a model call
        const noProjectResources = /^--no-approve(?:\s+|$)/.test(args.trim());
        const plan = await planWorkspace(pi, ctx, args.trim().replace(/^--no-approve(?:\s+|$)/, ""));
        const profile = roleProfile("coordinator");
        const name = finalName(plan.name, await agentList(pi), "coordinator");
        const ws = await herdr(pi, ["workspace", "create", "--cwd", plan.dir, "--label", name, "--env", `PI_CODING_AGENT_DIR=${getAgentDir()}`]);
        const paneId = findPaneId(ws);
        if (!paneId) throw new Error("workspace created but no pane_id in response");
        await agentOp(pi, ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--",
          ...profileArgs(name, profile, "interactive"), ...(noProjectResources ? ["--no-approve"] : [])], name, paneId);
        ctx.ui.notify(`🐑 ${name} — pi ready in ${plan.dir.replace(process.env.HOME ?? "", "~")} (focused).`, "info");
      } catch (e) {
        ctx.ui.notify(`ws: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
