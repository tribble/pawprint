import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeCtx, makePi } from "./harness.mjs";
import { git, mktmp } from "./fixture.ts";

export function fleetRepo(dir = mktmp("fleet")) {
  const source = join(dir, "source");
  mkdirSync(source, { recursive: true });
  git(source, "init", "-q", "-b", "main");
  assert.equal(git(source, "rev-parse", "--show-toplevel"), source);
  git(source, "config", "core.hooksPath", join(dir, "empty-hooks"));
  git(source, "config", "commit.gpgsign", "false");
  writeFileSync(join(source, "shared.txt"), "baseline\n");
  git(source, "add", "--", "shared.txt");
  git(source, "commit", "-q", "-m", "fixture");
  return { dir, source };
}

export function fleetParent(cwd: string, sessionId = "fleet-owner") {
  const roster: Record<string, unknown>[] = [{ name: "parent", pane_id: "wT:p1", workspace_id: "wT", cwd }];
  const workspaces: Record<string, unknown>[] = [];
  let childId: string | undefined;
  const children = mktmp("native-children");
  let childFile = "";
  let childCwd = cwd;
  let childWorkspace = "wT";
  let childPane = "wT:p2";
  const pi = makePi({ execImpl: async (cmd: string, args: string[]) => {
    if (cmd === "git") {
      const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, killed: r.signal !== null };
    }
    let result: unknown = {};
    if (args[0] === "tab") {
      childCwd = args[args.indexOf("--cwd") + 1];
      childWorkspace = args[args.indexOf("--workspace") + 1];
      let index = 2;
      while (roster.some((agent) => agent.pane_id === `${childWorkspace}:p${index}`)) index++;
      childPane = `${childWorkspace}:p${index}`;
      result = { root_pane: { pane_id: childPane } };
    }
    else if (args[0] === "workspace" && args[1] === "list") result = { workspaces };
    else if (args[1] === "list") result = { agents: roster };
    else if (args[1] === "start") {
      childId = args[args.indexOf("--session-id") + 1];
      childFile = join(children, `2026-01-01T00-00-00-000Z_${childId}.jsonl`);
      roster.push({ name: args[2], pane_id: childPane, workspace_id: childWorkspace, cwd: childCwd, agent_status: "working", agent_session: { kind: "path", value: childFile } });
    }
    else if (args[1] === "get") result = { agent: { pane_id: childPane, agent_session: { kind: "path", value: childFile } } };
    else if (args[1] === "prompt") writeFileSync(childFile, JSON.stringify({ type: "session", id: childId, cwd: realpathSync.native(childCwd) }) + "\n");
    else if (args[0] === "pane") result = { process_info: { pane_id: "wT:p2", shell_pid: 123, foreground_processes: [{ name: "zsh", pid: 123 }] } };
    return { code: 0, stdout: JSON.stringify({ result }), stderr: "", killed: false };
  } });
  const sessionFile = join(mktmp("fleet-parent"), `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n");
  roster[0].agent_session = { kind: "path", value: sessionFile };
  const append = pi.appendEntry.bind(pi);
  const timestamps: string[] = [];
  pi.appendEntry = (type: string, data: unknown) => {
    append(type, data);
    timestamps.push(new Date().toISOString());
    appendFileSync(sessionFile, JSON.stringify({ type: "custom", customType: type, data }) + "\n");
  };
  const ctx = makeCtx({ cwd, sessionId, sessionFile });
  ctx.sessionManager.getEntries = () => pi.state.entries.map((e: { type: string; data: unknown }, i: number) => ({
    type: "custom", customType: e.type, data: e.data, timestamp: timestamps[i],
  }));
  return { pi, ctx, roster, workspaces };
}
