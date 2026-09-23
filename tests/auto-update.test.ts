// auto-update.ts: daily TTL gate, single-flight lock, notify-only on
// session_start, /update reloads when extensions changed; weekly pin-review
// reminder; /packages lists pins vs upstream and `bump` moves them + commits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "./stubs/pi-coding-agent.mjs";
import { makePi, makeCtx, eventually } from "./harness.mjs";
import { git } from "./fixture.ts";
import { parseSource, renderTable } from "../extensions/auto-update.ts";

let seq = 0;
async function freshExtension(agentDir: string) {
  setAgentDir(agentDir); // captured at module load (STATE/LOCK paths)
  const mod = await import(`../extensions/auto-update.ts?case=${seq++}`);
  return mod.default;
}

const now = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
// Default state: the weekly review is fresh, so only the daily update is under test.
function setup(lastRun?: string, lastPackagesReview: string | null = now()) {
  const dir = mkdtempSync(join(tmpdir(), "pawprint-autoupdate-"));
  writeFileSync(join(dir, ".auto-update.json"), JSON.stringify({ lastRun, lastPackagesReview: lastPackagesReview ?? undefined }));
  return dir;
}
const state = (dir: string) => JSON.parse(readFileSync(join(dir, ".auto-update.json"), "utf8"));

test("registers session_start handler and /update command", async () => {
  const ext = await freshExtension(setup());
  const pi = makePi();
  ext(pi);
  assert.equal(pi.registered("session_start"), 1);
  assert.ok(pi.commands.update);
});

test("fresh state: runs both updates, writes state, releases lock", async () => {
  const dir = setup();
  const ext = await freshExtension(dir);
  const pi = makePi();
  ext(pi);
  await pi.emit("session_start", {}, makeCtx());
  const ok = await eventually(() => state(dir).lastRun);
  assert.ok(ok, "state file written");
  assert.deepEqual(
    pi.execCalls.filter((c: string[]) => c[0] === "pi"),
    [
      ["pi", "update", "--self"],
      ["pi", "update", "--extensions", "--no-approve"],
    ],
    "both update commands ran",
  );
  await eventually(() => !existsSync(join(dir, ".auto-update.json.lock")));
  assert.ok(!existsSync(join(dir, ".auto-update.json.lock")), "lock released");
  const st = JSON.parse(readFileSync(join(dir, ".auto-update.json"), "utf8"));
  assert.ok(Date.parse(st.lastRun), "lastRun is a real timestamp");
});

test("TTL: recent lastRun skips all work", async () => {
  const dir = setup(new Date().toISOString());
  const ext = await freshExtension(dir);
  const pi = makePi();
  ext(pi);
  await pi.emit("session_start", {}, makeCtx());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pi.execCalls.filter((c: string[]) => c[0] === "pi").length, 0);
});

test("lock present: another session owns the update, return early", async () => {
  const dir = setup();
  mkdirSync(join(dir, ".auto-update.json.lock"));
  const ext = await freshExtension(dir);
  const pi = makePi();
  ext(pi);
  await pi.emit("session_start", {}, makeCtx());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pi.execCalls.length, 0);
  assert.equal(state(dir).lastRun, undefined, "no state written by loser");
});

test("session_start notifies only when something changed", async () => {
  const dir = setup();
  const ext = await freshExtension(dir);
  const pi = makePi({
    execImpl: async (_c: string, args: string[]) => ({
      code: 0,
      stdout: args.includes("--self") ? "pi is already up to date" : "Updating pkg-a\nDone",
      stderr: "",
    }),
  });
  ext(pi);
  const ctx = makeCtx();
  await pi.emit("session_start", {}, ctx);
  await eventually(() => ctx.notes.length > 0);
  assert.equal(ctx.notes[0].msg, "auto-update: packages updated — /reload to apply");
  assert.equal(ctx.notes[0].level, "info");
  assert.equal(ctx.reloads, 0, "session_start never reloads");
});

test("/update: extension change triggers reload; clean run does not", async () => {
  const dir = setup();
  const ext = await freshExtension(dir);
  let extStdout = "Updating pkg-a\nDone";
  const pi = makePi({
    execImpl: async (_c: string, args: string[]) => ({
      code: 0,
      stdout: args.includes("--self") ? "already up to date" : extStdout,
      stderr: "",
    }),
  });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.update.handler("", ctx);
  assert.equal(ctx.reloads, 1, "extChanged → reload");
  assert.ok(ctx.notes.some((n: any) => n.msg.includes("packages updated")));

  extStdout = "All packages up to date";
  const ctx2 = makeCtx();
  await pi.commands.update.handler("", ctx2);
  assert.equal(ctx2.reloads, 0);
  assert.ok(ctx2.notes.some((n: any) => n.msg === "Everything up to date."));
});

test("/update: headless ctx returns without doing anything", async () => {
  const dir = setup();
  const ext = await freshExtension(dir);
  const pi = makePi();
  ext(pi);
  const ctx = makeCtx();
  ctx.hasUI = false;
  await pi.commands.update.handler("", ctx);
  assert.equal(pi.execCalls.length, 0);
});

// ------------------------------------------------------ weekly review ---

test("weekly reminder: due when lastPackagesReview is absent or > 7 days old, exact text, no exec", async () => {
  for (const last of [null, daysAgo(8)]) {
    const dir = setup(now(), last);
    const ext = await freshExtension(dir);
    const pi = makePi();
    ext(pi);
    const ctx = makeCtx();
    await pi.emit("session_start", {}, ctx);
    assert.deepEqual(ctx.notes, [{ msg: "auto-update: weekly package review due — /packages", level: "info" }]);
    assert.equal(pi.execCalls.filter((c: string[]) => c[0] === "pi").length, 0, "reminder is independent of the daily update");
  }
});

test("weekly reminder: quiet within 7 days; /packages resets the clock", async () => {
  const dir = setup(now(), daysAgo(6));
  const ext = await freshExtension(dir);
  const pi = makePi();
  ext(pi);
  const ctx = makeCtx();
  await pi.emit("session_start", {}, ctx);
  assert.deepEqual(ctx.notes, []);

  const yesterday = daysAgo(1);
  const stale = setup(yesterday, daysAgo(30));
  const ext2 = await freshExtension(stale);
  const pi2 = makePi();
  ext2(pi2);
  writeFileSync(join(stale, "settings.json"), JSON.stringify({ packages: [] }));
  await pi2.commands.packages.handler("", makeCtx());
  assert.ok(Date.now() - Date.parse(state(stale).lastPackagesReview) < 5000, "reset to now");
  assert.equal(state(stale).lastRun, yesterday, "other keys untouched (merge, not overwrite)");
});

// ---------------------------------------------------------- /packages ---

test("parseSource: every source form pi documents", () => {
  const A = "/a";
  assert.deepEqual(parseSource("git:github.com/o/r", A), { index: 0, source: "git:github.com/o/r", kind: "git", name: "o/r", ref: undefined, dir: "/a/git/github.com/o/r" });
  assert.equal(parseSource("git:github.com/o/r@abc123", A).ref, "abc123");
  assert.equal(parseSource("git:github.com/o/r.git@v1", A).dir, "/a/git/github.com/o/r");
  assert.deepEqual(parseSource("git:git@github.com:o/r@v1", A), { index: 0, source: "git:git@github.com:o/r@v1", kind: "git", name: "o/r", ref: "v1", dir: "/a/git/github.com/o/r" });
  assert.equal(parseSource("ssh://git@github.com/o/r@v1", A).dir, "/a/git/github.com/o/r");
  assert.equal(parseSource("https://github.com/o/r", A).name, "o/r");
  assert.deepEqual([parseSource("git:github.com/o/r@release/v1", A).ref, parseSource("git:github.com/o/r@release/v1", A).dir], ["release/v1", "/a/git/github.com/o/r"]);
  assert.equal(parseSource("ssh://git@example.com:2222/o/r@v1", A).dir, "/a/git/example.com/o/r");
  assert.deepEqual(parseSource("npm:@s/p@1.2.3", A, 4), { index: 4, source: "npm:@s/p@1.2.3", kind: "npm", name: "@s/p", ref: "1.2.3" });
  assert.deepEqual(parseSource("npm:plain", A), { index: 0, source: "npm:plain", kind: "npm", name: "plain", ref: undefined });
  assert.equal(parseSource("/abs/path", A).kind, "local");
});

test("renderTable: padded columns, last column unpadded, no trailing spaces", () => {
  assert.equal(renderTable([["package", "pinned", "behind"], ["o/r", "abc1234 09-06", "14"], ["x", "floating", ""]]),
    "package  pinned         behind\no/r      abc1234 09-06  14\nx        floating");
});

// Fake registry: `npm view <name> version` answers from the map; `npm install <name>@<v> --prefix <root>`
// writes the package.json pi's install would leave under <root>/node_modules/<name>.
function npmFake(versions: Record<string, string>) {
  return (args: string[]) => {
    if (args[0] === "view") return `${versions[args[1]]}\n`;
    const [name, v] = args[1].match(/^(.+)@([^@]+)$/)!.slice(1);
    const dir = join(args[args.indexOf("--prefix") + 1], "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: v }));
    return "";
  };
}

// Real git in throwaway repos; npm + pi are faked. `git` and `npm` go through
// pi.exec, so one execImpl routes each.
function realExec(fake: Record<string, (args: string[]) => string> = {}) {
  return async (cmd: string, args: string[]) => {
    if (fake[cmd]) return { code: 0, stdout: fake[cmd](args), stderr: "" };
    return new Promise<{ code: number; stdout: string; stderr: string }>((res) =>
      execFile(cmd, args, { encoding: "utf8" }, (e, stdout, stderr) => res({ code: e ? Number((e as any).code) || 1 : 0, stdout, stderr })),
    );
  };
}

// Upstream repo with 3 commits; the clone under <agentDir>/git/<host>/<path> is pinned at the first.
function pinnedClone(agentDir: string, host = "example.com", path = "o/r") {
  const up = mkdtempSync(join(tmpdir(), "pawprint-upstream-"));
  git(up, "init", "-q", "-b", "main");
  const shas: string[] = [];
  for (const n of [1, 2, 3]) {
    writeFileSync(join(up, "f"), `${n}\n`);
    git(up, "add", "f");
    git(up, "commit", "-q", "--no-verify", "-m", `commit ${n}`);
    shas.push(git(up, "rev-parse", "HEAD"));
  }
  const dir = join(agentDir, "git", host, path);
  mkdirSync(join(agentDir, "git", host), { recursive: true });
  git(agentDir, "clone", "-q", up, dir);
  git(dir, "checkout", "-q", shas[0]);
  return { up, dir, shas, source: `git:${host}/${path}@${shas[0]}` };
}

test("/packages: behind = commits pin..origin/HEAD after a fetch; npm and floating rows", async () => {
  const dir = setup();
  const { up, shas, source } = pinnedClone(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [source, "git:example.com/o/float", { source: "npm:@s/p@0.1.2" }, "npm:@s/q@2.0.0"] }));
  // A 4th upstream commit the clone has not fetched yet.
  writeFileSync(join(up, "f"), "4\n");
  git(up, "add", "f");
  git(up, "commit", "-q", "--no-verify", "-m", "fix: fourth");
  const ext = await freshExtension(dir);
  const pi = makePi({ execImpl: realExec({ npm: (a) => (a[1] === "@s/p" ? "0.1.3\n" : "2.0.0\n") }) });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.packages.handler("", ctx);
  const date = git(up, "log", "-1", "--format=%ad", "--date=short");
  const pinDate = git(up, "log", "-1", "--format=%ad", "--date=format:%m-%d", shas[0]);
  assert.equal(ctx.notes.length, 1);
  assert.equal(ctx.notes[0].msg, renderTable([
    ["package", "pinned", "behind", "latest"],
    ["o/r", `${shas[0].slice(0, 7)} ${pinDate}`, "3", `${date} fix: fourth`],
    ["o/float", "floating", "—", ""],
    ["@s/p", "0.1.2", "", "0.1.3 available"],
    ["@s/q", "2.0.0", "0", ""],
  ]));
});

// The config repo: <root>/agent is the agent dir, root tracks agent/settings.json and pushes to a bare origin.
function configRepo(settings: unknown) {
  const root = mkdtempSync(join(tmpdir(), "pawprint-cfg-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, ".auto-update.json"), JSON.stringify({ lastRun: now(), lastPackagesReview: now() }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  writeFileSync(join(root, ".gitignore"), "*\n!.gitignore\n!agent/\n!agent/settings.json\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@t");
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "base");
  const origin = mkdtempSync(join(tmpdir(), "pawprint-cfg-origin-"));
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "-u", "origin", "main");
  return { root, agentDir, origin };
}

// ------------------------------------------------------------- stamp ---

const stampWrite = (agentDir: string, v: string) => {
  const f = join(agentDir, "settings.json");
  writeFileSync(f, readFileSync(f, "utf8").replace(/"lastChangelogVersion": "[^"]*"/, `"lastChangelogVersion": "${v}"`));
};
const settled = (agentDir: string) => eventually(() => !existsSync(join(agentDir, ".auto-update.json.lock")));
async function startSession(agentDir: string, execImpl = realExec({ pi: () => "" })) {
  const ext = await freshExtension(agentDir);
  const pi = makePi({ execImpl });
  ext(pi);
  const ctx = makeCtx();
  await pi.emit("session_start", {}, ctx);
  await settled(agentDir);
  return { pi, ctx };
}

test("stamp: pi's lastChangelogVersion write alone → committed 'pi <ver> stamp' and pushed on session_start, silently", async () => {
  const { root, agentDir, origin } = configRepo({ lastChangelogVersion: "0.87.0", theme: "x" });
  stampWrite(agentDir, "0.88.0");
  const { ctx } = await startSession(agentDir);
  assert.equal(git(root, "status", "--porcelain"), "", "committed");
  assert.equal(git(root, "log", "-1", "--format=%s"), "pi 0.88.0 stamp");
  assert.equal(git(origin, "rev-parse", "main"), git(root, "rev-parse", "HEAD"), "pushed");
  assert.deepEqual(ctx.notes, [], "silent");
});

test("stamp: anything else dirty (stamp + another change) → untouched", async () => {
  const { root, agentDir } = configRepo({ lastChangelogVersion: "0.87.0", theme: "x" });
  const head = git(root, "rev-parse", "HEAD");
  const f = join(agentDir, "settings.json");
  writeFileSync(f, readFileSync(f, "utf8").replace('"theme": "x"', '"theme": "y"'));
  stampWrite(agentDir, "0.88.0");
  const { pi } = await startSession(agentDir);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "status", "--porcelain"), "M agent/settings.json"); // fixture git() trims
  assert.ok(!pi.execCalls.some((c: string[]) => c.includes("commit")), "no commit attempted");
});

test("stamp: agent dir not in a git repo → nothing happens, no error", async () => {
  const dir = setup();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ lastChangelogVersion: "0.88.0" }, null, 2));
  const { pi } = await startSession(dir);
  assert.ok(!pi.execCalls.some((c: string[]) => c.includes("commit")));
});

test("stamp: a save landing mid-check → not committed, still dirty, next start retries", async () => {
  const { root, agentDir, origin } = configRepo({ lastChangelogVersion: "0.87.0", theme: "x" });
  stampWrite(agentDir, "0.88.0");
  const f = join(agentDir, "settings.json");
  const head = git(root, "rev-parse", "HEAD");
  const theirs = readFileSync(f, "utf8").replace('"theme": "x"', '"theme": "saved-during-check"');
  await startSession(agentDir, async (cmd: string, args: string[]) => {
    if (cmd === "git" && args.includes("show")) writeFileSync(f, theirs); // another pane saves
    return realExec({ pi: () => "" })(cmd, args);
  });
  assert.equal(git(root, "rev-parse", "HEAD"), head, "nothing committed");
  assert.equal(readFileSync(f, "utf8"), theirs, "their save intact");
  assert.equal(git(root, "status", "--porcelain"), "M agent/settings.json");
  assert.equal(git(origin, "rev-parse", "main"), head);
});

test("stamp: a failed push is retried next start; unpushed non-stamp commits are never pushed", async () => {
  const { root, agentDir, origin } = configRepo({ lastChangelogVersion: "0.87.0" });
  stampWrite(agentDir, "0.88.0");
  renameSync(origin, origin + ".away"); // offline
  await startSession(agentDir);
  assert.equal(git(root, "log", "-1", "--format=%s"), "pi 0.88.0 stamp");
  assert.equal(git(root, "status", "--porcelain"), "");
  renameSync(origin + ".away", origin); // back online, fresh session
  await startSession(agentDir);
  assert.equal(git(origin, "rev-parse", "main"), git(root, "rev-parse", "HEAD"), "pushed on retry");

  // the owner's own unpushed commit on top: not ours to push
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lastChangelogVersion: "0.88.0", theme: "mine" }, null, 2) + "\n");
  git(root, "commit", "-q", "--no-verify", "-am", "theme");
  const { pi } = await startSession(agentDir);
  assert.equal(git(root, "rev-list", "--count", "origin/main..HEAD"), "1", "left unpushed");
  assert.ok(!pi.execCalls.some((c: string[]) => c.includes("push")));
});

test("stamp: pi.exec throwing mid-check (reload invalidated the API) is contained — lock released, no unhandled rejection", async () => {
  const { agentDir } = configRepo({ lastChangelogVersion: "0.87.0" });
  stampWrite(agentDir, "0.88.0");
  const rejections: unknown[] = [];
  const onRej = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRej);
  await startSession(agentDir, async (cmd: string, args: string[]) => { if (args.includes("show")) throw new Error("extension API invalidated"); return realExec()(cmd, args); });
  assert.ok(!existsSync(join(agentDir, ".auto-update.json.lock")), "lock released");
  await new Promise((r) => setTimeout(r, 50));
  process.off("unhandledRejection", onRej);
  assert.deepEqual(rejections, []);
});

test("/packages bump --all: rewrites every pin that is behind (string + object form), pi update, one commit, pushed", async () => {
  const { root, agentDir, origin } = configRepo({ packages: [] });
  const { shas, source } = pinnedClone(agentDir);
  const b = pinnedClone(agentDir, "example.com", "o/kit");
  git(b.dir, "checkout", "-q", b.shas[2]);   // already at HEAD: not behind
  const settings = {
    theme: "x",
    packages: ["git:example.com/tribble/float", { source, extensions: ["e.ts"] }, `git:example.com/o/kit@${b.shas[2]}`, "npm:@s/p@0.1.2", "npm:@s/q@2.0.0"],
  };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  git(root, "commit", "-q", "--no-verify", "-am", "pins");
  git(root, "push", "-q");
  const ext = await freshExtension(agentDir);
  const pi = makePi({ execImpl: realExec({ npm: npmFake({ "@s/p": "0.1.3", "@s/q": "2.0.0" }), pi: () => "" }) });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.packages.handler("bump --all", ctx);
  assert.deepEqual(ctx.notes, [{ msg: "bumped 2 — /reload to load them", level: "info" }]);
  const after = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(after, {
    theme: "x",
    packages: ["git:example.com/tribble/float", { source: `git:example.com/o/r@${shas[2]}`, extensions: ["e.ts"] }, `git:example.com/o/kit@${b.shas[2]}`, "npm:@s/p@0.1.3", "npm:@s/q@2.0.0"],
  });
  assert.ok(pi.execCalls.some((c: string[]) => c.join(" ") === "pi update --extensions --no-approve"), "clone reconciled");
  assert.equal(git(root, "log", "-1", "--format=%s"), "packages: bump 2 (r, p)");
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(git(origin, "rev-parse", "main"), git(root, "rev-parse", "HEAD"), "pushed");
});

test("/packages bump <name>: one pin by short name, its own commit message; current → 'is current'; unknown → error", async () => {
  const { root, agentDir } = configRepo({ packages: [] });
  const { shas, source } = pinnedClone(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [source, "npm:@s/p@0.1.2"] }, null, 2) + "\n");
  git(root, "commit", "-q", "--no-verify", "-am", "pins");
  git(root, "push", "-q");
  const ext = await freshExtension(agentDir);
  const pi = makePi({ execImpl: realExec({ npm: () => "0.1.2\n", pi: () => "" }) });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.packages.handler("bump r", ctx);
  assert.deepEqual(ctx.notes, [{ msg: `bumped r ${shas[0].slice(0, 7)}→${shas[2].slice(0, 7)} — /reload to load it`, level: "info" }]);
  assert.equal(git(root, "log", "-1", "--format=%s"), `packages: bump r ${shas[0].slice(0, 7)}→${shas[2].slice(0, 7)}`);
  const text = readFileSync(join(agentDir, "settings.json"), "utf8");
  assert.ok(text.endsWith("}\n"), "trailing newline preserved");
  assert.equal(JSON.parse(text).packages[0], `git:example.com/o/r@${shas[2]}`);

  const ctx2 = makeCtx();
  await pi.commands.packages.handler("bump p", ctx2);
  assert.deepEqual(ctx2.notes, [{ msg: "p is current", level: "info" }]);
  const ctx3 = makeCtx();
  await pi.commands.packages.handler("bump nope", ctx3);
  assert.equal(ctx3.notes[0].level, "error");
  assert.match(ctx3.notes[0].msg, /no package named nope/);
});

test("/packages bump: a dirty config worktree aborts before anything is read or written", async () => {
  const { root, agentDir } = configRepo({ packages: ["npm:@s/p@0.1.2"] });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@s/p@0.1.2"], theme: "edited" }, null, 2));
  const ext = await freshExtension(agentDir);
  const pi = makePi({ execImpl: realExec({ npm: () => "9.9.9\n", pi: () => "" }) });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.packages.handler("bump --all", ctx);
  assert.equal(ctx.notes.length, 1);
  assert.equal(ctx.notes[0].level, "error");
  assert.match(ctx.notes[0].msg, new RegExp(`${root} has uncommitted changes.*agent/settings.json`));
  assert.ok(!pi.execCalls.some((c: string[]) => c[0] === "npm"), "nothing fetched");
  assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).theme, "edited", "untouched");
});

test("/packages bump: `pi update` failing restores the committed pins, commits nothing, review not counted", async () => {
  const { root, agentDir } = configRepo({ packages: [] });
  const { source } = pinnedClone(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [source] }, null, 2));
  git(root, "commit", "-q", "--no-verify", "-am", "pins");
  git(root, "push", "-q");
  writeFileSync(join(agentDir, ".auto-update.json"), JSON.stringify({ lastPackagesReview: daysAgo(9) }));
  const text = readFileSync(join(agentDir, "settings.json"), "utf8");
  const head = git(root, "rev-parse", "HEAD");
  const ext = await freshExtension(agentDir);
  let piRuns = 0;
  const pi = makePi({ execImpl: async (cmd: string, args: string[]) => (cmd === "pi" ? { code: piRuns++ === 0 ? 1 : 0, stdout: "", stderr: "clone failed" } : realExec()(cmd, args)) });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.packages.handler("bump --all", ctx);
  assert.equal(ctx.notes.length, 1);
  assert.equal(ctx.notes[0].level, "error");
  assert.match(ctx.notes[0].msg, /pi update --extensions failed: clone failed — pins restored, clones reconciled/);
  assert.equal(piRuns, 2, "a second pi update moves the clones back to the restored pins");
  assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), text, "pins restored byte-for-byte");
  assert.equal(git(root, "rev-parse", "HEAD"), head, "nothing committed");
  assert.equal(git(root, "status", "--porcelain"), "", "worktree clean for the next bump");
  assert.equal(state(agentDir).lastPackagesReview, daysAgo(9).slice(0, 10) + state(agentDir).lastPackagesReview.slice(10), "review not counted");
});

test("/packages bump: settings.json edited while upstream was being checked → aborts, nothing written", async () => {
  const { agentDir } = configRepo({ packages: ["npm:@s/p@0.1.2"] });
  const file = join(agentDir, "settings.json");
  const ext = await freshExtension(agentDir);
  const pi = makePi({
    execImpl: async (cmd: string, args: string[]) => {
      if (cmd === "npm") { // another pane saves a setting mid-check
        writeFileSync(file, JSON.stringify({ packages: ["npm:@s/p@0.1.2"], theme: "new" }, null, 2));
        return { code: 0, stdout: "0.1.3\n", stderr: "" };
      }
      return realExec({ pi: () => "" })(cmd, args);
    },
  });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.packages.handler("bump --all", ctx);
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0].msg, /has uncommitted changes.*agent\/settings.json/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { packages: ["npm:@s/p@0.1.2"], theme: "new" }, "the other pane's edit is intact, pin untouched");
  assert.ok(!pi.execCalls.some((c: string[]) => c[0] === "pi"), "no pi update");
});

test("/packages: a failed upstream check is shown as such, never as current; review not counted; bump refuses", async () => {
  const dir = setup(now(), daysAgo(9));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["npm:@s/p@0.1.2", "npm:@s/q@1.0.0"] }));
  const ext = await freshExtension(dir);
  const pi = makePi({
    execImpl: async (cmd: string, args: string[]) =>
      cmd === "git" ? { code: 0, stdout: "", stderr: "" } // clean worktree
      : args[1] === "@s/p" ? { code: 1, stdout: "", stderr: "npm ERR! E404" }
      : { code: 0, stdout: "1.0.0\n", stderr: "" },
  });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.packages.handler("", ctx);
  assert.equal(ctx.notes[0].level, "warning");
  assert.equal(ctx.notes[0].msg, renderTable([
    ["package", "pinned", "behind", "latest"],
    ["@s/p", "0.1.2", "?", "check failed: npm view @s/p version: npm ERR! E404"],
    ["@s/q", "1.0.0", "0", ""],
  ]));
  assert.ok(Date.now() - Date.parse(state(dir).lastPackagesReview) > 8 * 86_400_000, "review not counted");

  const ctx2 = makeCtx();
  await pi.commands.packages.handler("bump --all", ctx2);
  assert.equal(ctx2.notes.length, 1);
  assert.equal(ctx2.notes[0].level, "error");
  assert.match(ctx2.notes[0].msg, /check failed, nothing bumped — @s\/p: npm view @s\/p version: npm ERR! E404/);
  assert.ok(!pi.execCalls.some((c: string[]) => c[0] === "pi"), "no pi update");
});

test("timeouts: a killed command is a failure everywhere (pi.exec resolves killed=true with code 0)", async () => {
  // upstream check killed → shown as failed, review not counted
  const dir = setup(now(), daysAgo(9));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["npm:@s/p@0.1.2"] }));
  const ext = await freshExtension(dir);
  const pi = makePi({ execImpl: async () => ({ code: 0, stdout: "", stderr: "", killed: true }) });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.packages.handler("", ctx);
  assert.equal(ctx.notes[0].level, "warning");
  assert.match(ctx.notes[0].msg, /@s\/p\s+0\.1\.2\s+\?\s+check failed: npm view @s\/p version: timed out after 60s/);
  assert.ok(Date.now() - Date.parse(state(dir).lastPackagesReview) > 8 * 86_400_000, "review not counted");

  // pi update killed during bump → pins restored, nothing committed
  const { root, agentDir } = configRepo({ packages: ["npm:@s/p@0.1.2"] });
  const text = readFileSync(join(agentDir, "settings.json"), "utf8");
  const ext2 = await freshExtension(agentDir);
  const pi2 = makePi({ execImpl: async (cmd: string, args: string[]) => (cmd === "pi" ? { code: 0, stdout: "", stderr: "", killed: true } : realExec({ npm: npmFake({ "@s/p": "0.1.3" }) })(cmd, args)) });
  ext2(pi2);
  const ctx2 = makeCtx();
  await pi2.commands.packages.handler("bump --all", ctx2);
  assert.deepEqual(ctx2.notes.map((n: any) => n.level), ["error"]);
  assert.match(ctx2.notes[0].msg, /pi update --extensions failed: timed out after 300s — pins restored, but clones may still sit at the new ref: pi update --extensions/);
  assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), text);
  assert.equal(git(root, "log", "-1", "--format=%s"), "base");

  // daily update killed → counts as failed, never as "pi updated"
  const dir3 = setup();
  const ext3 = await freshExtension(dir3);
  const pi3 = makePi({ execImpl: async () => ({ code: 0, stdout: "", stderr: "", killed: true }) });
  ext3(pi3);
  const ctx3 = makeCtx();
  await pi3.commands.update.handler("", ctx3);
  assert.ok(ctx3.notes.some((n: any) => n.level === "warning" && /part of the update failed/.test(n.msg)));
  assert.ok(!ctx3.notes.some((n: any) => /updated/.test(n.msg)), "no success claim");
});

test("/packages bump: settings.json saved by another pane while `pi update` ran → their bytes stay, nothing committed; unrelated tracked edits never ride along", async () => {
  const { root, agentDir } = configRepo({ packages: ["npm:@s/p@0.1.2"] });
  const file = join(agentDir, "settings.json");
  const ext = await freshExtension(agentDir);
  const theirs = JSON.stringify({ packages: ["npm:@s/p@0.1.3"], theme: "saved-during-update" }, null, 2);
  const pi = makePi({
    execImpl: async (cmd: string, args: string[]) => {
      if (cmd === "pi") { writeFileSync(file, theirs); return { code: 0, stdout: "", stderr: "" }; }
      return realExec({ npm: npmFake({ "@s/p": "0.1.3" }) })(cmd, args);
    },
  });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.packages.handler("bump --all", ctx);
  assert.deepEqual(ctx.notes.map((n: any) => n.level), ["error"]);
  assert.match(ctx.notes[0].msg, /changed while packages installed — installed, nothing committed: git -C .* add -p agent\/settings.json/);
  assert.equal(readFileSync(file, "utf8"), theirs, "the other pane's save is intact");
  assert.equal(git(root, "log", "-1", "--format=%s"), "base");

  // the failure branch likewise leaves a changed file alone (no restore over their save)
  const { root: r2, agentDir: a2 } = configRepo({ packages: ["npm:@s/p@0.1.2"] });
  const f2 = join(a2, "settings.json");
  const ext2 = await freshExtension(a2);
  const pi2 = makePi({
    execImpl: async (cmd: string, args: string[]) => {
      if (cmd === "pi") { writeFileSync(f2, theirs); return { code: 1, stdout: "", stderr: "boom" }; }
      return realExec({ npm: npmFake({ "@s/p": "0.1.3" }) })(cmd, args);
    },
  });
  ext2(pi2);
  const ctx2 = makeCtx();
  await pi2.commands.packages.handler("bump --all", ctx2);
  assert.match(ctx2.notes[0].msg, /pi update --extensions failed: boom; .* changed meanwhile — sort it out by hand: git -C .* diff/);
  assert.equal(readFileSync(f2, "utf8"), theirs);
  assert.equal(git(r2, "status", "--porcelain"), "M agent/settings.json"); // fixture git() trims

  // a tracked file edited elsewhere during pi update is not swept into the bump commit
  const { root: r3, agentDir: a3 } = configRepo({ packages: ["npm:@s/p@0.1.2"] });
  writeFileSync(join(r3, ".gitignore"), "*\n!.gitignore\n!agent/\n!agent/settings.json\n!agent/other.json\n");
  writeFileSync(join(a3, "other.json"), "{}\n");
  git(r3, "add", "-A"); git(r3, "commit", "-q", "--no-verify", "-m", "other"); git(r3, "push", "-q");
  const ext3 = await freshExtension(a3);
  const pi3 = makePi({
    execImpl: async (cmd: string, args: string[]) => {
      if (cmd === "pi") { writeFileSync(join(a3, "other.json"), "{\"edited\":1}\n"); return { code: 0, stdout: "", stderr: "" }; }
      return realExec({ npm: npmFake({ "@s/p": "0.1.3" }) })(cmd, args);
    },
  });
  ext3(pi3);
  const ctx3 = makeCtx();
  await pi3.commands.packages.handler("bump --all", ctx3);
  assert.deepEqual(ctx3.notes, [{ msg: "bumped 1 — /reload to load them", level: "info" }]);
  assert.equal(git(r3, "show", "--stat", "--format=", "HEAD").trim().split("\n")[0].trim().split(" ")[0], "agent/settings.json");
  assert.equal(git(r3, "status", "--porcelain"), "M agent/other.json", "their edit still uncommitted, not lost");
});

test("/packages bump: an npm bump is installed into <agentDir>/npm and verified before commit; a bad install rolls back", async () => {
  const { root, agentDir, origin } = configRepo({ packages: ["npm:@s/p@0.1.2"] });
  const ext = await freshExtension(agentDir);
  const pi = makePi({ execImpl: realExec({ npm: npmFake({ "@s/p": "0.1.3" }), pi: () => "" }) });
  ext(pi);
  const ctx = makeCtx();
  await pi.commands.packages.handler("bump p", ctx);
  assert.deepEqual(ctx.notes, [{ msg: "bumped p 0.1.2→0.1.3 — /reload to load it", level: "info" }]);
  const install = pi.execCalls.find((c: string[]) => c[0] === "npm" && c[1] === "install");
  assert.deepEqual(install, ["npm", "install", "@s/p@0.1.3", "--prefix", join(agentDir, "npm"), "--legacy-peer-deps"], "pi's own user-scope install shape");
  assert.equal(JSON.parse(readFileSync(join(agentDir, "npm", "node_modules", "@s", "p", "package.json"), "utf8")).version, "0.1.3");
  assert.equal(git(origin, "rev-parse", "main"), git(root, "rev-parse", "HEAD"), "published after install");

  // registry answers 0.1.4 but the install leaves 0.1.3 behind → not published, pins restored
  const { root: r2, agentDir: a2 } = configRepo({ packages: ["npm:@s/p@0.1.2"] });
  const text = readFileSync(join(a2, "settings.json"), "utf8");
  const ext2 = await freshExtension(a2);
  const lying = npmFake({ "@s/p": "0.1.4" });
  const pi2 = makePi({ execImpl: realExec({ npm: (a) => (a[0] === "view" ? lying(a) : lying([a[0], a[1].replace("0.1.4", "0.1.3"), ...a.slice(2)])), pi: () => "" }) });
  ext2(pi2);
  const ctx2 = makeCtx();
  await pi2.commands.packages.handler("bump p", ctx2);
  assert.equal(ctx2.notes[0].level, "error");
  assert.match(ctx2.notes[0].msg, /npm install @s\/p@0\.1\.4 left 0\.1\.3 installed — pins restored, clones reconciled/);
  assert.equal(readFileSync(join(a2, "settings.json"), "utf8"), text);
  assert.equal(git(r2, "log", "-1", "--format=%s"), "base");
});
