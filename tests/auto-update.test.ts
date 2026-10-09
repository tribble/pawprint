// auto-update.ts: session_start never updates (no subprocess, no lock);
// /update reloads when extensions changed; weekly pin-review reminder;
// /packages lists pins vs upstream (read-only) and routes bump/install/remove
// as queued source-repo tasks; one-off Opus 5.5 watch notifies once Pi's
// bundled catalog ships the dashed id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setAgentDir } from "./stubs/pi-coding-agent.mjs";
import { makePi, makeCtx } from "./harness.mjs";
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
// Default state: the weekly review is fresh, so the reminder stays quiet unless under test.
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

test("session_start runs no update: no pi subprocess, no lock acquisition, no lastRun — fresh or due", async () => {
  const LOCK = ".auto-update.json.lock";
  for (const lastRun of [undefined, daysAgo(2)]) {
    const dir = setup(lastRun);
    const ext = await freshExtension(dir);
    // Observe acquisition in-window: watch the state dir, and hold every subprocess
    // at the gate so a lock taken around update work is still held when
    // session_start returns.
    const lockEvents: string[] = [];
    const watcher = watch(dir, (_event, name) => {
      if (name === LOCK) lockEvents.push(LOCK);
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = () => r(); });
    const pi = makePi({ execImpl: async () => { await gate; return { code: 0, stdout: "", stderr: "" }; } });
    try {
      ext(pi);
      await pi.emit("session_start", {}, makeCtx());
      assert.ok(!existsSync(join(dir, LOCK)), "no lock held when session_start returns");
      release();
      await new Promise((r) => setTimeout(r, 100)); // settle: released work and fs events land
      assert.deepEqual(pi.execCalls.filter((c: string[]) => c[0] === "pi"), [], "no update subprocesses");
      assert.deepEqual(lockEvents, [], "lock never created, not even transiently");
      assert.equal(state(dir).lastRun, lastRun, "lastRun untouched by session_start");
    } finally {
      release();
      watcher.close();
    }
  }
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
  assert.ok(ctx.notes.some((n: { msg: string; level: string }) => n.msg.includes("packages updated")));

  extStdout = "All packages up to date";
  const ctx2 = makeCtx();
  await pi.commands.update.handler("", ctx2);
  assert.equal(ctx2.reloads, 0);
  assert.ok(ctx2.notes.some((n: { msg: string; level: string }) => n.msg === "Everything up to date."));
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

test("weekly reminder: due when lastPackagesReview is absent or > 7 days old, exact text", async () => {
  for (const last of [null, daysAgo(8)]) {
    const dir = setup(now(), last);
    const ext = await freshExtension(dir);
    const pi = makePi();
    ext(pi);
    const ctx = makeCtx();
    await pi.emit("session_start", {}, ctx);
    assert.deepEqual(ctx.notes, [{ msg: "auto-update: weekly package review due — /packages", level: "info" }]);
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

// Real git in throwaway repos; npm + pi are faked. `git` and `npm` go through
// pi.exec, so one execImpl routes each.
function realExec(fake: Record<string, (args: string[]) => string> = {}) {
  return async (cmd: string, args: string[]) => {
    if (fake[cmd]) return { code: 0, stdout: fake[cmd](args), stderr: "" };
    return new Promise<{ code: number; stdout: string; stderr: string }>((res) =>
      execFile(cmd, args, { encoding: "utf8" }, (e, stdout, stderr) => res({ code: e ? Number(e.code) || 1 : 0, stdout, stderr })),
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

test("/packages: a failed upstream check is shown as such, never as current; review not counted", async () => {
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

  // daily update killed → counts as failed, never as "pi updated"
  const dir3 = setup();
  const ext3 = await freshExtension(dir3);
  const pi3 = makePi({ execImpl: async () => ({ code: 0, stdout: "", stderr: "", killed: true }) });
  ext3(pi3);
  const ctx3 = makeCtx();
  await pi3.commands.update.handler("", ctx3);
  assert.ok(ctx3.notes.some((n: { msg: string; level: string }) => n.level === "warning" && /part of the update failed/.test(n.msg)));
  assert.ok(!ctx3.notes.some((n: { msg: string }) => /updated/.test(n.msg)), "no success claim");
});

// ------------------------------------------- /packages mutation routing ---

test("/packages mutation commands queue a source-worktree task — requested only: no exec, no writes, no review credit", async () => {
  const review = daysAgo(3);
  for (const args of ["bump o/r", "bump --all", "install git:github.com/o/new@abc123", "remove o/r"]) {
    const dir = setup(now(), review);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["git:example.com/o/r@abc123"] }));
    const before = readFileSync(join(dir, "settings.json"), "utf8");
    const ext = await freshExtension(dir);
    const pi = makePi();
    ext(pi);
    const ctx = makeCtx();
    await pi.commands.packages.handler(args, ctx);
    assert.equal(pi.userMessages.length, 1, "exactly one queued task");
    const { content, opts } = pi.userMessages[0];
    assert.equal(opts?.deliverAs, "followUp", "queued behind current work, not an interruption");
    assert.ok(content.includes(`Owner outcome:\n/packages ${args}\n`), "handoff carries an Owner outcome block with the user command verbatim");
    assert.ok(!content.includes(`Owner outcome:\n\`/packages`), "block body is verbatim, not decorated");
    assert.match(content, /[Nn]othing has been (changed|applied)/, "marked as a request, not a result");
    assert.ok(content.includes("git:github.com/tribble/pawprint"), "settled ownership: floating self entry is the exception");
    assert.match(content, /worktree/, "normal source worktree/review/commit flow");
    assert.match(content, /verify/i, "independent verification demanded");
    assert.equal(ctx.notes.length, 1);
    assert.equal(ctx.notes[0].level, "info");
    assert.match(ctx.notes[0].msg, /queued/i);
    assert.ok(!/bumped|updated|installed|removed|committed|pushed|applied/i.test(ctx.notes[0].msg), "never reads as done");
    assert.equal(pi.execCalls.length, 0, "no git/npm/pi exec");
    assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), before, "live settings untouched");
    assert.equal(state(dir).lastPackagesReview, review, "a queued request is not a review");
  }
  for (const args of ["bump", "install", "remove", "frobnicate x"]) {
    const dir = setup();
    const ext = await freshExtension(dir);
    const pi = makePi();
    ext(pi);
    const ctx = makeCtx();
    await pi.commands.packages.handler(args, ctx);
    assert.equal(pi.userMessages.length, 0, `${args}: nothing queued`);
    assert.equal(pi.execCalls.length, 0, `${args}: no exec`);
    assert.equal(ctx.notes[0]?.level, "error", `${args}: usage error`);
  }
});

// -------------------------------------------------- opus 5.5 watch ---
// The watch reads the bundled catalog of the RUNNING install, found by walking
// up from argv[1] (the cli.js the shim execs). A fake install tree exercises
// the real path end to end — no production seam.
const OPUS_NOTICE =
  "Pi now ships the correct Opus 5.5 gateway ID — delete the local claude-opus-5-5 entry from agent/models.json (and this check)";
const FIXED_CATALOG = JSON.stringify({ "anthropic-messages": { "chat:claude-opus-5-5": { id: "claude-opus-5-5" } } });
const DOTTED_CATALOG = JSON.stringify({ "anthropic-messages": { "chat:claude-opus-5.5": { id: "claude-opus-5.5" } } });

/** A fake pi install: <root>/bin/cli.js plus pi-ai's catalog (unless undefined). Returns cli.js. */
function fakePiInstall(catalog: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "pawprint-opuswatch-"));
  const dataDir = join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
  mkdirSync(dataDir, { recursive: true });
  if (catalog !== undefined) writeFileSync(join(dataDir, "cloudflare-ai-gateway.json"), catalog);
  const cli = join(root, "bin", "cli.js");
  mkdirSync(dirname(cli));
  writeFileSync(cli, "// fake pi entry\n");
  return cli;
}

test("opus 5.5 watch: notice iff the running install's bundled catalog ships the dashed id; malformed/missing/headless silent", async () => {
  const argv1 = process.argv[1];
  const start = async (catalog: string | undefined, hasUI = true) => {
    process.argv[1] = fakePiInstall(catalog);
    const ext = await freshExtension(setup(now())); // daily not due, review fresh: no other notes
    const pi = makePi();
    ext(pi);
    const ctx = makeCtx();
    ctx.hasUI = hasUI;
    await pi.emit("session_start", {}, ctx);
    return ctx.notes;
  };
  try {
    assert.deepEqual(await start(FIXED_CATALOG), [{ msg: OPUS_NOTICE, level: "info" }]);
    assert.deepEqual(await start(DOTTED_CATALOG), [], "today's dotted catalog stays silent");
    assert.deepEqual(await start("{ malformed"), [], "unparseable catalog stays silent");
    assert.deepEqual(await start(undefined), [], "missing catalog stays silent");
    assert.deepEqual(await start(FIXED_CATALOG, false), [], "noninteractive stays silent");
  } finally {
    process.argv[1] = argv1;
  }
});
