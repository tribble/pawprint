import { mock, test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import herdrFleet from "../extensions/herdr-fleet.ts";
import { fleetParent, fleetRepo } from "./fleet-fixture.ts";
import { git, mktmp } from "./fixture.ts";
import { setAgentDir } from "./stubs/pi-coding-agent.mjs";

setAgentDir(new URL("../agent", import.meta.url).pathname);
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "wT:p1";
delete process.env.PI_SUBAGENT_CHILD;
const task = "Owner outcome:\nKeep source work intact.\n";
const launch = (parent: ReturnType<typeof fleetParent>, params: Record<string, unknown> = {}) =>
  parent.pi.tools.launch_agent.execute("launch", { name: "lead", task, ...params }, undefined, undefined, parent.ctx);
const release = (parent: ReturnType<typeof fleetParent>, cwd: string) =>
  parent.pi.tools.release_worktree.execute("release", { cwd }, undefined, undefined, parent.ctx);
function linked() {
  const fixture = fleetRepo();
  const cwd = join(fixture.dir, "existing");
  git(fixture.source, "worktree", "add", "-q", "-b", "existing", cwd);
  return { ...fixture, cwd };
}
const paneMutations = (parent: ReturnType<typeof fleetParent>) => parent.pi.execCalls.filter((call: string[]) =>
  call[0] === "herdr" && (call[1] === "tab" || ["start", "prompt"].includes(call[2])));

test("registered Coder launcher creates two independent worktrees without transferring dirty source work", async () => {
  const { source } = fleetRepo();
  writeFileSync(join(source, "shared.txt"), "source work\n");
  writeFileSync(join(source, "unrelated.txt"), "untracked source work\n");
  const before = git(source, "status", "--porcelain");
  const { pi, ctx } = fleetParent(source);
  herdrFleet(pi);
  const a = await pi.tools.launch_agent.execute("a", { name: "alpha", task }, undefined, undefined, ctx);
  const b = await pi.tools.launch_agent.execute("b", { name: "bravo", task }, undefined, undefined, ctx);
  assert.notEqual(a.details.cwd, source, "the default must not share the source checkout");
  assert.notEqual(a.details.cwd, b.details.cwd);
  assert.equal(readFileSync(join(a.details.cwd, "shared.txt"), "utf8"), "baseline\n");
  assert.equal(existsSync(join(a.details.cwd, "unrelated.txt")), false);
  writeFileSync(join(a.details.cwd, "shared.txt"), "alpha work\n");
  writeFileSync(join(b.details.cwd, "shared.txt"), "bravo work\n");
  assert.equal(readFileSync(join(a.details.cwd, "shared.txt"), "utf8"), "alpha work\n");
  assert.equal(readFileSync(join(b.details.cwd, "shared.txt"), "utf8"), "bravo work\n");
  assert.equal(git(source, "status", "--porcelain"), before);
  assert.equal(readFileSync(join(source, "shared.txt"), "utf8"), "source work\n");
  const starts = pi.execCalls.filter((call: string[]) => call[0] === "herdr" && call[2] === "start");
  assert.equal(starts[0][starts[0].indexOf("--session-id") + 1], a.details.childSessionId);
  assert.equal(a.details.baseCommit, git(source, "rev-parse", "HEAD"));
  assert.equal(JSON.parse(readFileSync(a.details.claimPath, "utf8")).ownerSessionId, "fleet-owner");
});

test("base is rejected for explicit reuse and for Coordinators before any pane mutation", async () => {
  const { source } = fleetRepo();
  const { pi, ctx } = fleetParent(source);
  herdrFleet(pi);
  for (const params of [{ cwd: source }, { role: "coordinator" }]) {
    await assert.rejects(() => pi.tools.launch_agent.execute("bad", { name: "lead", task, base: "HEAD", ...params }, undefined, undefined, ctx), /base/i);
  }
  assert.equal(pi.execCalls.filter((call: string[]) => call[0] === "herdr").length, 0);
});

test("explicit cwd admits exactly a linked subdirectory, canonical aliases share a claim, including the caller", async () => {
  const { source, cwd, dir } = linked();
  mkdirSync(join(cwd, "nested"));
  const alias = join(dir, "alias");
  symlinkSync(cwd, alias);
  const parent = fleetParent(source);
  herdrFleet(parent.pi);
  const result = await launch(parent, { cwd: join(alias, "nested") });
  assert.equal(result.details.cwd, join(cwd, "nested"));
  assert.equal(result.details.worktreeKey, git(cwd, "rev-parse", "--absolute-git-dir"));
  const before = paneMutations(parent).length;
  await assert.rejects(() => launch(parent, { cwd }), /already claimed/);
  assert.equal(paneMutations(parent).length, before);
});

test("primary and non-Git Coder cwd are refused; a Coordinator keeps its non-Git directory", async () => {
  const { source } = fleetRepo();
  const plain = mktmp("plain");
  writeFileSync(join(plain, ".git"), `gitdir: ${join(plain, "missing")}\n`);
  const parent = fleetParent(source);
  herdrFleet(parent.pi);
  await assert.rejects(() => launch(parent, { cwd: source }), /linked task worktree/);
  await assert.rejects(() => launch(parent, { cwd: plain }), /git rev-parse/);
  assert.equal(paneMutations(parent).length, 0);
  const coordinator = await launch(parent, { role: "coordinator", cwd: plain });
  assert.equal(coordinator.details.cwd, plain);
  assert.equal(coordinator.details.claimPath, undefined);
});

test("unowned alias occupancy blocks reuse, while an unclaimed direct parent can plan alongside the Coder", async () => {
  const { cwd, dir } = linked();
  const alias = join(dir, "alias");
  symlinkSync(cwd, alias);
  const parent = fleetParent(cwd);
  herdrFleet(parent.pi);
  parent.roster.push({ name: "human-neighbor", pane_id: "wU:p4", workspace_id: "wT", foreground_cwd: alias });
  await assert.rejects(() => launch(parent, { cwd }), /occupied by human-neighbor.*Occupancy does not prove writer status/);
  assert.equal(paneMutations(parent).length, 0);
  parent.roster.length = 1;
  assert.equal((await launch(parent, { cwd })).details.cwd, cwd);
});

test("admission and pre-pane release do not trigger an unchosen promisor neighbor's SSH command", async () => {
  const { source, cwd } = linked();
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi/settings.json"), "{}");
  const neighbor = fleetRepo();
  const repo = neighbor.source;
  const marker = join(neighbor.dir, "ssh-command-ran");
  git(repo, "config", "core.repositoryformatversion", "1");
  git(repo, "config", "extensions.partialClone", "origin");
  git(repo, "config", "remote.origin.url", "ssh://example.invalid/x");
  git(repo, "config", "remote.origin.promisor", "true");
  git(repo, "config", "core.sshCommand", `touch '${marker}'; false`);
  writeFileSync(join(repo, ".git/refs/heads/main"), "0123456789abcdef0123456789abcdef01234567\n");
  mkdirSync(join(repo, "nested"));
  const alias = join(neighbor.dir, "alias");
  symlinkSync(repo, alias);
  const parent = fleetParent(source);
  parent.roster.push({ name: "neighbor", pane_id: "wU:p9", workspace_id: "wU", cwd: repo, foreground_cwd: join(alias, "nested") });
  herdrFleet(parent.pi);
  const lazyFetch = process.env.GIT_NO_LAZY_FETCH;
  delete process.env.GIT_NO_LAZY_FETCH;
  try {
    assert.equal(existsSync(marker), false);
    await assert.rejects(() => launch(parent, { cwd }), /Project trust decision required/);
    assert.equal(existsSync(marker), false, "admission must not execute the neighbor's SSH command");
    const failed = parent.pi.state.entries.at(-1).data;
    assert.equal(failed.phase, "failed-before-pane");
    const claim = join(failed.worktreeKey, "pawprint-writer.json");
    assert.equal(existsSync(claim), true);
    await release(parent, cwd);
    assert.equal(existsSync(claim), false);
    assert.equal(existsSync(marker), false, "release must not execute the neighbor's SSH command");
  } finally {
    if (lazyFetch === undefined) delete process.env.GIT_NO_LAZY_FETCH;
    else process.env.GIT_NO_LAZY_FETCH = lazyFetch;
  }
});

test("post-start claims remain held after child exit; copied UUID/history cannot own another session file", async () => {
  const { source } = fleetRepo();
  const owner = fleetParent(source);
  herdrFleet(owner.pi);
  const result = await launch(owner);
  for (const status of ["idle", "done", "unknown"]) {
    owner.roster[1].agent_status = status;
    await assert.rejects(() => release(owner, result.details.cwd), /detached workers stopped/);
  }
  const fork = fleetParent(source, "fork-owner");
  fork.ctx.sessionManager.getEntries = owner.ctx.sessionManager.getEntries;
  herdrFleet(fork.pi);
  await assert.rejects(() => release(fork, result.details.cwd), /canonical-file-bound owner/);
  const copied = fleetParent(source, "fleet-owner");
  copied.ctx.sessionManager.getEntries = owner.ctx.sessionManager.getEntries;
  herdrFleet(copied.pi);
  await assert.rejects(() => release(copied, result.details.cwd), /canonical-file-bound owner/);
  owner.roster.length = 1;
  await assert.rejects(() => release(owner, result.details.cwd), /cannot be reassigned/);
  assert.equal(existsSync(result.details.claimPath), true);
  assert.equal(existsSync(result.details.cwd), true);
  assert.equal(git(source, "rev-parse", result.details.branch), result.details.baseCommit);
});

test("missing native identity and uncertain task delivery keep claims even when the child disappears", async () => {
  for (const failedPhase of ["get", "prompt", "header"]) {
    const { source } = fleetRepo();
    const parent = fleetParent(source);
    const exec = parent.pi.execImpl;
    parent.pi.execImpl = async (cmd: string, args: string[]) => {
      if (cmd === "herdr" && args[1] === failedPhase) return { code: failedPhase === "get" ? 0 : 1, stdout: '{"result":{}}', stderr: "uncertain delivery", killed: false };
      const result = await exec(cmd, args);
      if (failedPhase === "header" && args[1] === "prompt") {
        const ref = parent.roster[1].agent_session as { value: string };
        writeFileSync(ref.value, JSON.stringify({ type: "session", id: "wrong-child", cwd: source }) + "\n");
      }
      return result;
    };
    herdrFleet(parent.pi);
    await assert.rejects(() => launch(parent), /Keep partial state/);
    const record = parent.pi.state.entries.at(-1).data;
    assert.equal(record.phase, "uncertain");
    parent.roster.length = 1;
    await assert.rejects(() => release(parent, record.cwd), /uncertain/);
    assert.equal(existsSync(join(record.worktreeKey, "pawprint-writer.json")), true);
  }
});

test("post-start, altered claim bytes and an orphaned native record all fail closed on release", async () => {
  const { source } = fleetRepo();
  const parent = fleetParent(source);
  herdrFleet(parent.pi);
  const result = await launch(parent);
  parent.roster.length = 1;
  const exec = parent.pi.execImpl;
  parent.pi.execImpl = async (cmd: string, args: string[]) => args[0] === "pane"
    ? { code: 0, stdout: '{"result":{"process_info":{"foreground_processes":[]}}}', stderr: "", killed: false }
    : exec(cmd, args);
  await assert.rejects(() => release(parent, result.details.cwd), /detached workers stopped/);
  parent.pi.execImpl = exec;
  const text = readFileSync(result.details.claimPath, "utf8");
  writeFileSync(result.details.claimPath, `${text} `);
  await assert.rejects(() => release(parent, result.details.cwd), /uncertain/);
  writeFileSync(result.details.claimPath, text);
  parent.ctx.sessionManager.getEntries = () => [];
  await assert.rejects(() => release(parent, result.details.cwd), /uncertain/);
  assert.equal(existsSync(result.details.claimPath), true);
});

test("in-memory Coder parents are refused before any exec; Coordinator directory behavior remains", async () => {
  const { source } = fleetRepo();
  const parent = fleetParent(source);
  parent.ctx.sessionManager.getSessionFile = () => undefined;
  herdrFleet(parent.pi);
  await assert.rejects(() => launch(parent), /persistent native parent.*without --no-session/);
  assert.equal(parent.pi.execCalls.length, 0);
  assert.equal((await launch(parent, { role: "coordinator" })).details.cwd, source);
});

test("native owner-file symlinks preserve ownership, while copied and moved files do not", async () => {
  const { source, dir } = fleetRepo();
  mkdirSync(join(source, ".pi"));
  writeFileSync(join(source, ".pi/settings.json"), "{}");
  git(source, "add", ".pi/settings.json");
  git(source, "commit", "-q", "-m", "resources");
  const parent = fleetParent(source);
  const file = parent.ctx.sessionManager.getSessionFile();
  herdrFleet(parent.pi);
  await assert.rejects(() => launch(parent), /Project trust decision required/);
  const failed = parent.pi.state.entries.at(-1).data;
  const moved = join(dir, "owner-moved.jsonl");
  renameSync(file, moved);
  parent.ctx.sessionManager.getSessionFile = () => moved;
  await assert.rejects(() => release(parent, failed.cwd), /canonical-file-bound owner/);
  renameSync(moved, file);
  const alias = join(dir, "owner-alias.jsonl");
  symlinkSync(file, alias);
  parent.ctx.sessionManager.getSessionFile = () => alias;
  await release(parent, failed.cwd);
  assert.equal(existsSync(join(failed.worktreeKey, "pawprint-writer.json")), false);
});

test("case-variant paths use physical cwd and native owner-file spelling", (t) => {
  const { cwd, dir } = linked();
  const variant = join(dir, "EXISTING");
  if (!existsSync(variant)) { t.skip("requires a case-insensitive filesystem"); return; }
  return (async () => {
    const parent = fleetParent(cwd);
    const file = parent.ctx.sessionManager.getSessionFile();
    parent.ctx.sessionManager.getSessionFile = () => file.replace("fleet-owner", "FLEET-OWNER");
    herdrFleet(parent.pi);
    const result = await launch(parent, { cwd: variant });
    assert.equal(result.details.cwd, cwd);
    assert.equal(result.details.ownerSessionFile, file);
    assert.equal(parent.pi.state.entries.at(-1).data.phase, "prompted");
  })();
});

test("destination/ref collisions and uncertain Git add preserve inspectable state without a retry", async () => {
  for (const collision of ["path", "branch", "after-add"]) {
    const { source } = fleetRepo();
    const parent = fleetParent(source);
    const append = parent.pi.appendEntry.bind(parent.pi);
    parent.pi.appendEntry = (type: string, data: { phase: string; cwd: string; branch: string }) => {
      append(type, data);
      if (data.phase !== "git-requested") return;
      if (collision === "path") { mkdirSync(data.cwd); writeFileSync(join(data.cwd, "keep.txt"), "unrelated\n"); }
      if (collision === "branch") git(source, "branch", data.branch);
    };
    const exec = parent.pi.execImpl;
    parent.pi.execImpl = async (cmd: string, args: string[]) => {
      const result = await exec(cmd, args);
      return collision === "after-add" && cmd === "git" && args.includes("add") && args.includes("worktree")
        ? { ...result, code: 1, stderr: "response lost after Git add" } : result;
    };
    herdrFleet(parent.pi);
    await assert.rejects(() => launch(parent), /Keep partial state/);
    const record = parent.pi.state.entries.at(-1).data;
    assert.equal(existsSync(record.cwd), true);
    assert.equal(paneMutations(parent).length, 0);
    if (collision === "path") assert.equal(readFileSync(join(record.cwd, "keep.txt"), "utf8"), "unrelated\n");
    else assert.equal(git(source, "rev-parse", record.branch), record.baseCommit);
    assert.ok(parent.pi.execCalls.filter((call: string[]) => call.includes("worktree") && call.includes("add")).length <= 1);
  }
});

test("tab/start/prompt failures retain the claim and pane evidence; no automatic cleanup or second mutation", async () => {
  for (const phase of ["tab", "start", "prompt"]) {
    const { source } = fleetRepo();
    const parent = fleetParent(source);
    const exec = parent.pi.execImpl;
    parent.pi.execImpl = async (cmd: string, args: string[]) => {
      if (cmd === "herdr" && (args[0] === phase || args[1] === phase)) return { code: 1, stdout: "", stderr: "response lost", killed: false };
      return exec(cmd, args);
    };
    herdrFleet(parent.pi);
    await assert.rejects(() => launch(parent), /Keep partial state/);
    const record = parent.pi.state.entries.at(-1).data;
    assert.equal(record.phase, "uncertain");
    assert.equal(existsSync(join(record.worktreeKey, "pawprint-writer.json")), true);
    assert.equal(record.paneId, phase === "tab" ? undefined : "wT:p2");
    assert.equal(parent.pi.execCalls.some((call: string[]) => call.includes("close") || call.includes("remove")), false);
  }
});

test("native trust is checked on the new worktree; explicit opt-out cannot approve it", async () => {
  const { source } = fleetRepo();
  mkdirSync(join(source, ".pi"));
  writeFileSync(join(source, ".pi/settings.json"), "{}");
  git(source, "add", ".pi/settings.json");
  git(source, "commit", "-q", "-m", "project resources");
  const parent = fleetParent(source);
  herdrFleet(parent.pi);
  await assert.rejects(() => launch(parent), /Project trust decision required.*release_worktree.*cwd/s);
  assert.equal(paneMutations(parent).length, 0);
  const failed = parent.pi.state.entries.at(-1).data;
  assert.notEqual(failed.cwd, source);
  await release(parent, failed.cwd);
  const optedOut = await launch(parent, { cwd: failed.cwd, noProjectResources: true });
  assert.equal(optedOut.details.cwd, failed.cwd);
  const start = parent.pi.execCalls.find((call: string[]) => call[0] === "herdr" && call[2] === "start");
  assert.ok(start.includes("--no-approve"));
  assert.equal(parent.pi.execCalls.flat().includes("--approve"), false);
  assert.notEqual(optedOut.details.cwd, source);
});

test("claim readback I/O failure preserves uncertain state and malformed JSON names its path", async () => {
  const { cwd } = linked();
  const parent = fleetParent(cwd);
  herdrFleet(parent.pi);
  const path = join(git(cwd, "rev-parse", "--absolute-git-dir"), "pawprint-writer.json");
  const read = fs.readFileSync;
  const fault = mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === path) throw new Error("fixture claim readback I/O failed");
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => launch(parent, { cwd }), (error: Error) => {
      assert.match(error.message, /claim creation\/write\/readback.*state is uncertain/s);
      assert.ok(error.message.includes(path));
      assert.equal(error.message.includes("no writer claim was created"), false);
      return true;
    });
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(path), true);
  assert.equal(paneMutations(parent).length, 0);
  await assert.rejects(() => release(parent, cwd), /uncertain/);
  writeFileSync(path, "{");
  await assert.rejects(() => launch(parent, { cwd }), (error: Error) => {
    assert.match(error.message, /Malformed writer claim JSON; keep and inspect/);
    assert.ok(error.message.includes(path));
    return true;
  });
  assert.equal(readFileSync(path, "utf8"), "{");
});

test("explicit committed base and the human shortcut share the native path", async () => {
  const { source } = fleetRepo();
  const base = git(source, "rev-parse", "HEAD");
  git(source, "branch", "chosen-base", base);
  writeFileSync(join(source, "shared.txt"), "later commit\n");
  git(source, "add", "shared.txt");
  git(source, "commit", "-q", "-m", "later");
  const parent = fleetParent(source);
  herdrFleet(parent.pi);
  await parent.pi.commands.delegate.handler(`--base chosen-base lead ${task}`, parent.ctx);
  const record = parent.pi.state.entries.at(-1).data;
  assert.equal(record.phase, "prompted");
  assert.equal(record.baseCommit, base);
  assert.equal(readFileSync(join(record.cwd, "shared.txt"), "utf8"), "baseline\n");
  assert.equal(parent.pi.execCalls.some((call: string[]) => call.includes("fetch")), false);
});

test("/fleet labels only current-session native identities as owned, never neighboring or copied records", async () => {
  const { source } = fleetRepo();
  const parent = fleetParent(source);
  herdrFleet(parent.pi);
  await launch(parent);
  parent.roster.push({ name: "neighbor", pane_id: "wT:p3", workspace_id: "wT", cwd: source });
  await parent.pi.commands.fleet.handler("", parent.ctx);
  const text = parent.ctx.notes.at(-1).msg;
  assert.match(text, /lead.*\[mine\]/);
  assert.match(text, /neighbor.*\[yours\]/);
  const fork = fleetParent(source, "fork");
  fork.ctx.sessionManager.getEntries = parent.ctx.sessionManager.getEntries;
  fork.roster.push(...parent.roster.slice(1));
  herdrFleet(fork.pi);
  await fork.pi.commands.fleet.handler("", fork.ctx);
  assert.equal(fork.ctx.notes.at(-1).msg.includes("[mine]"), false);
  const copied = fleetParent(source, "fleet-owner");
  copied.ctx.sessionManager.getEntries = parent.ctx.sessionManager.getEntries;
  copied.roster.push(...parent.roster.slice(1));
  herdrFleet(copied.pi);
  await copied.pi.commands.fleet.handler("", copied.ctx);
  assert.equal(copied.ctx.notes.at(-1).msg.includes("[mine]"), false);
});
