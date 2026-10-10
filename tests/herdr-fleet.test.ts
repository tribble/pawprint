// herdr-fleet.ts: /fleet renders sorted live agent status; /delegate spawns
// a named tab in the caller's workspace and prompts it. All herdr calls are fake pi.exec records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { makePi as harnessPi, makeCtx as harnessCtx } from "./harness.mjs";
import { fleetRepo } from "./fleet-fixture.ts";
import { git } from "./fixture.ts";
import herdrFleet from "../extensions/herdr-fleet.ts";
import { setAgentDir } from "./stubs/pi-coding-agent.mjs";

const sourceAgentDir = new URL("../agent", import.meta.url).pathname;
setAgentDir(sourceAgentDir);

const testSource = fleetRepo().source;
function linkedTaskDir() {
  const { dir, source } = fleetRepo();
  const cwd = join(dir, "task");
  git(source, "worktree", "add", "-q", "-b", "task", cwd);
  assert.equal(git(cwd, "rev-parse", "--show-toplevel"), cwd);
  return cwd;
}
const makeCtx = (options = {}) => harnessCtx({ cwd: testSource, sessionFile: join(testSource, "parent-session.jsonl"), ...options });
function makePi(options: { execImpl?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> } = {}) {
  let childId = "";
  return harnessPi({ ...options, execImpl: async (cmd: string, args: string[]) => {
    if (cmd === "git") {
      const result = spawnSync(cmd, args, { encoding: "utf8" });
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    }
    if (args[1] === "start") childId = args[args.indexOf("--session-id") + 1];
    if (args[0] === "agent" && args[1] === "get") return {
      code: 0, stdout: JSON.stringify({ result: { agent: { agent_session: { kind: "id", value: childId } } } }), stderr: "",
    };
    return options.execImpl?.(cmd, args) ?? { code: 0, stdout: "", stderr: "" };
  } });
}

// These existing cases own herdr topology/profile/task transport. The isolation
// suite owns Git and native identity reads, including the allocated session ID.
function calls(pi: ReturnType<typeof makePi>) {
  let listed = false;
  return pi["execCalls"].filter((call: string[]) => {
    if (call[0] !== "herdr" || (call[1] === "agent" && call[2] === "get")) return false;
    const isList = call[1] === "agent" && call[2] === "list";
    if (isList && listed) return false;
    listed = isList;
    return true;
  }).map((call: string[]) => call.filter((_arg, index) => call[index] !== "--session-id" && call[index - 1] !== "--session-id"));
}

// Table rows have no real panes; reset only their fixture admission state.
function clearFixtureClaim(cwd: string) {
  const path = join(git(cwd, "rev-parse", "--absolute-git-dir"), "pawprint-writer.json");
  if (existsSync(path)) unlinkSync(path);
}
const comparableTransport = (rows: string[][]) => rows.map((row) => row[1] === "tab" ? row.map((value, index) => index === 6 ? "<fresh-worktree>" : value) : row);

const agentsReply = (agents: unknown) => ({
  code: 0,
  stdout: JSON.stringify({ result: { agents } }),
  stderr: "",
});

// The extension identifies "me" by HERDR_PANE_ID and refuses herdr calls unless HERDR_ENV=1;
// pin both so tests are the same inside and outside herdr.
process.env.HERDR_PANE_ID = "wH:p1";
process.env.HERDR_ENV = "1";
delete process.env.PI_SUBAGENT_CHILD; // Exercise the interactive parent boundary unless a case selects a leaf.
const ME = { name: "coordinator-test", agent_status: "idle", cwd: "/tmp/me", pane_id: "wH:p1", workspace_id: "wH" };
// Children are addressed to my intercom ID (pi-<sha256(session id)[0:32]>), never my name, which can change.
// sha256("fleet-sess").hex[0:32], precomputed so the test does not share the implementation's formula.
const SESSION_ID = "fleet-sess";
const MY_ID = "pi-8271896c98088f150f678afd3ae5249e";
const fleetCtx = () => makeCtx({ sessionId: SESSION_ID });
const tabReply = { code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "wH:t2" }, root_pane: { pane_id: "wH:p2" } } }), stderr: "" };

test("/fleet: sorts status; neighboring same-workspace sessions are not owned", async () => {
  const pi = makePi({
    execImpl: async () =>
      agentsReply([
        { name: "zeta", agent_status: "done", cwd: "/tmp/z", pane_id: "w2:p1", workspace_id: "w2" },
        { name: "alpha", agent_status: "working", cwd: "/tmp/a", focused: true, pane_id: "wH:p2", workspace_id: "wH" },
        ME,
      ]),
  });
  herdrFleet(pi);
  const ctx = makeCtx();
  await pi.commands.fleet.handler("", ctx);
  const lines = ctx.notes[0].msg.split("\n");
  assert.deepEqual(
    lines.map((l: string) => l.trim()),
    ["→ ⚙ alpha  /tmp/a  [yours]", "○ coordinator-test  /tmp/me  [yours]", "✓ zeta  /tmp/z  [yours]"],
  );
  assert.deepEqual(calls(pi), [["herdr", "agent", "list"]]);
});

test("/fleet: empty roster and herdr failure both notify", async () => {
  const pi = makePi({ execImpl: async () => agentsReply([]) });
  herdrFleet(pi);
  const ctx = makeCtx();
  await pi.commands.fleet.handler("", ctx);
  assert.equal(ctx.notes[0].msg, "No herdr agents found.");

  const pi2 = makePi({ execImpl: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
  herdrFleet(pi2);
  const ctx2 = makeCtx();
  await pi2.commands.fleet.handler("", ctx2);
  assert.equal(ctx2.notes[0].level, "error");
  assert.ok(ctx2.notes[0].msg.startsWith("fleet: herdr agent list failed: boom"));
});

test("/delegate: usage error without name+task", async () => {
  const pi = makePi();
  herdrFleet(pi);
  const ctx = makeCtx();
  await pi.commands.delegate.handler("solo", ctx);
  assert.deepEqual(ctx.notes[0], { msg: "Usage: /delegate <name> <task>", level: "error" });
  assert.equal(pi.execCalls.length, 0);
});

test("/delegate: task without an `Owner outcome:` block is refused before anything is spawned", async () => {
  const pi = makePi({ execImpl: delegateExec([ME]) });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("scout fix the flake", ctx);
  assert.equal(ctx.notes.at(-1).level, "error");
  assert.ok(ctx.notes.at(-1).msg.includes("Owner outcome:"), ctx.notes.at(-1).msg);
  assert.equal(pi.execCalls.length, 0);
});

// Fake herdr for /delegate: `agent list` returns the given roster, `tab create` a tab+pane, everything else {}.
const delegateExec = (roster: unknown[]) => async (_c: string, args: string[]) => {
  if (args[0] === "agent" && args[1] === "list") return agentsReply(roster);
  if (args[0] === "tab") return tabReply;
  return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
};

test("/delegate: tab in MY workspace → explicit profile → pane-targeted task (verbatim owner + parent/close contract)", async () => {
  const pi = makePi({ execImpl: delegateExec([ME]) });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("scout Owner outcome: fix the flake", ctx);
  const launchedCwd = calls(pi)[1][6];
  assert.notEqual(launchedCwd, testSource);
  assert.deepEqual(calls(pi).slice(0, 2), [
    ["herdr", "agent", "list"],
    // a tab in the caller's workspace (grouped sidebar nests it under the caller), never a new workspace;
    // the spawner is identified by intercom ID, not by its (renamable) session name
    ["herdr", "tab", "create", "--workspace", "wH", "--cwd", launchedCwd, "--label", "scout", "--no-focus", "--env", `PI_CODING_AGENT_DIR=${sourceAgentDir}`, "--env", `PI_SPAWNED_BY=${MY_ID}`],
  ]);
  const start = calls(pi)[2];
  assert.deepEqual(start.slice(0, 13), ["herdr", "agent", "start", "scout", "--kind", "pi", "--pane", "wH:p2", "--timeout", "60000", "--", "--name", "scout"]);
  assert.equal(start[start.indexOf("--model") + 1], "cloudflare-ai-gateway/gpt-6-astra");
  assert.equal(start[start.indexOf("--thinking") + 1], "high");
  assert.match(readFileSync(start[start.indexOf("--append-system-prompt") + 1], "utf8"), /Coder/);
  const [prompt, ...rest] = calls(pi)[3].slice(4);
  assert.deepEqual([calls(pi)[3].slice(0, 4), rest], [["herdr", "agent", "prompt", "wH:p2"], ["--wait", "--until", "working", "--timeout", "10000"]]);
  assert.ok(prompt.startsWith("Owner outcome: fix the flake\n\n"), prompt);
  assert.ok(!prompt.includes("Approved mock"), prompt);
  assert.ok(prompt.includes("Copy the `Owner outcome:` block unchanged into every subagent brief"), prompt);
  assert.ok(prompt.includes(`report ONCE to intercom session \`${MY_ID}\` (that is your spawner's ID; use it verbatim)`), prompt);
  assert.ok(!prompt.includes("coordinator-test"), "the spawner's name is not an address");
  assert.ok(prompt.includes('herdr tab close "$HERDR_TAB_ID"'), prompt);
  assert.equal(calls(pi).length, 4);
  assert.ok(ctx.notes.at(-1).msg.includes("🐑 scout delegated"));
});

test("/delegate: own pane not in agent list (not inside herdr) → error, nothing created", async () => {
  const pi = makePi({ execImpl: delegateExec([{ name: "other", pane_id: "w2:p1", workspace_id: "w2" }]) });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("x Owner outcome: do thing", ctx);
  assert.deepEqual(calls(pi), [["herdr", "agent", "list"]]);
  assert.deepEqual(ctx.notes.at(-1), { msg: "delegate: /delegate needs to run inside a herdr pane", level: "error" });
});

test("/delegate: names taken by live agents → next free suffix for label, agent and --name (multi-digit suffix)", async () => {
  const taken = ["scout", ...Array.from({ length: 9 }, (_, i) => `scout-${i + 2}`)]; // scout … scout-10
  const pi = makePi({ execImpl: delegateExec([ME, ...taken.map((name, i) => ({ name, pane_id: `w2:p${i + 1}`, workspace_id: "w2" }))]) });
  herdrFleet(pi);
  await pi.commands.delegate.handler("scout Owner outcome: go", fleetCtx());
  assert.equal(calls(pi)[1][8], "scout-11"); // --label
  assert.equal(calls(pi)[2][3], "scout-11"); // agent start <name>
  assert.equal(calls(pi)[2][12], "scout-11"); // -- --name <name>
  assert.equal(calls(pi)[3][3], "wH:p2"); // delivery targets the returned pane
});

test("/delegate: tab without pane_id → error notify", async () => {
  const pi = makePi({
    execImpl: async (_c: string, args: string[]) => (args[1] === "list" ? agentsReply([ME]) : { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" }),
  });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("x Owner outcome: do thing", ctx);
  assert.equal(ctx.notes.at(-1).level, "error");
  assert.ok(ctx.notes.at(-1).msg.includes("no pane_id"));
});

// /ws de-dupes its name against live herdr agent names (the name is also the agent/intercom name).
const wsExec = (existing: string[]) => async (_c: string, args: string[]) => {
  if (args[0] === "agent" && args[1] === "list") return agentsReply(existing.map((name) => ({ name })));
  if (args[0] === "workspace" && args[1] === "create")
    return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "p3" } } }), stderr: "" };
  return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
};

// /ws reads ~/.pi/agent/configs/ws.json at call time; point HOME at a scratch dir with a known map.
function withWsConfig(repos: Record<string, string> | null, fn: () => Promise<void>) {
  const home = linkedTaskDir();
  const prev = process.env.HOME;
  process.env.HOME = home;
  if (repos) {
    mkdirSync(join(home, ".pi/agent/configs"), { recursive: true });
    writeFileSync(join(home, ".pi/agent/configs/ws.json"), JSON.stringify({ repos }));
  }
  return fn().finally(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
}

test("/ws <repo-id> <slug>: explicit id + slug → no model call, de-duped label, pi --name in that dir", () =>
  withWsConfig({ workos: "~/work/workos" }, async () => {
    const pi = makePi({ execImpl: wsExec(["fix-flaky-tests-coordinator"]) });
    herdrFleet(pi);
    const ctx = makeCtx();
    await pi.commands.ws.handler("workos fix-flaky-tests", ctx);
    assert.deepEqual(calls(pi).slice(0, 2), [
      ["herdr", "agent", "list"],
      ["herdr", "workspace", "create", "--cwd", `${process.env.HOME}/work/workos`, "--label", "fix-flaky-tests-coordinator-2", "--env", `PI_CODING_AGENT_DIR=${sourceAgentDir}`],
    ]);
    const start = calls(pi)[2];
    assert.deepEqual(start.slice(0, 13), ["herdr", "agent", "start", "fix-flaky-tests-coordinator-2", "--kind", "pi", "--pane", "p3", "--timeout", "60000", "--", "--name", "fix-flaky-tests-coordinator-2"]);
    assert.equal(calls(pi).length, 3);
    assert.equal(start[start.indexOf("--model") + 1], "cloudflare-ai-gateway/gpt-6-astra");
    assert.equal(start[start.indexOf("--thinking") + 1], "high");
    assert.match(readFileSync(start[start.indexOf("--append-system-prompt") + 1], "utf8"), /Coordinator/);
    assert.match(start.at(-1), /interactive/);
    assert.ok(!start.includes("--approve"));
  }));

test("/ws <prose>: model picks name AND repo from the configured ids only", () =>
  withWsConfig({ workos: "~/work/workos", pawprint: "~/work/pawprint" }, async () => {
    const pi = makePi({ execImpl: wsExec([]) });
    herdrFleet(pi);
    const ctx = makeCtx();
    // pi's Provider.stream ignores a raw `systemPrompt` field — the persona must arrive
    // normalized (normalizeContext) as the leading system message, or it is silently dropped.
    // Assertions run after the handler: it catches provider-thrown errors into error notes.
    let seenReq: { systemPrompt?: string; messages: { role: string; content: string }[] } | undefined;
    let seenOpts: Record<string, unknown> | undefined;
    ctx.modelRegistry = {
      getApiKeyAndHeaders: async () => ({ ok: true, headers: { h: "1" }, env: { E: "x" } }),
      getProvider: () => ({
        stream: (_m: unknown, req: { systemPrompt?: string; messages: { role: string; content: string }[] }, opts: Record<string, unknown>) => {
          seenReq = req;
          seenOpts = opts;
          return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: 'Sure:\n{"name": "Fix Flaky Mac Tests", "repo": "workos"}' }] }) };
        },
      }),
    };
    await pi.commands.ws.handler("the mac tests keep flaking in CI", ctx);
    assert.equal(seenReq?.systemPrompt, undefined, "raw systemPrompt field is dropped by providers");
    assert.equal(seenReq?.messages[0].role, "system", "planning persona leads the transcript");
    assert.ok(seenReq?.messages[0].content.includes("workos, pawprint"));
    assert.deepEqual(seenOpts?.env, { E: "x" });
    assert.ok(seenOpts && !("reasoning" in seenOpts), "planning call must not enable reasoning");
    assert.equal(calls(pi)[1][4], `${process.env.HOME}/work/workos`);
    assert.equal(calls(pi)[1][6], "fix-flaky-mac-tests-coordinator");
  }));

test("/ws: model can't place it / unknown repo → error, nothing created", () =>
  withWsConfig({ workos: "~/work/workos" }, async () => {
    const pi = makePi({ execImpl: wsExec([]) });
    herdrFleet(pi);
    const ctx = makeCtx();
    ctx.modelRegistry = {
      getApiKeyAndHeaders: async () => ({ ok: true }),
      getProvider: () => ({ stream: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"name":"x-y","repo":"atlas"}' }] }) }) }),
    };
    await pi.commands.ws.handler("something vague", ctx);
    assert.equal(ctx.notes[0].level, "error");
    assert.ok(ctx.notes[0].msg.includes("can't tell which repo"));
    assert.equal(pi.execCalls.length, 0);
  }));

test("/ws with no config and no dir → error naming the config file; no scan of ~/work", () =>
  withWsConfig(null, async () => {
    const pi = makePi({ execImpl: wsExec([]) });
    herdrFleet(pi);
    const ctx = makeCtx();
    await pi.commands.ws.handler("fix the thing", ctx);
    assert.equal(ctx.notes[0].level, "error");
    assert.ok(ctx.notes[0].msg.includes("configs/ws.json"));
    assert.equal(pi.execCalls.length, 0);
  }));

// --- herdr --skill alignment: HERDR_ENV guard, legal names, failure recovery ---

// The herdr skill forbids inspect/control from outside Herdr (HERDR_ENV=1).
function withHerdrEnv(value: string | undefined, fn: () => Promise<void>) {
  const prev = process.env.HERDR_ENV;
  if (value === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prev;
  });
}

// Anything but exactly "1" is outside Herdr: unset, empty, or another value.
const OUTSIDE_HERDR: (string | undefined)[] = [undefined, "", "0", "true"];

test("outside Herdr (unset/empty/non-1): /fleet and /delegate are refused before any herdr call", async () => {
  for (const bad of OUTSIDE_HERDR) {
    await withHerdrEnv(bad, async () => {
      const pi = makePi({ execImpl: delegateExec([ME]) });
      herdrFleet(pi);
      const ctx = fleetCtx();
      await pi.commands.fleet.handler("", ctx);
      assert.equal(ctx.notes.at(-1).level, "error", String(bad));
      assert.ok(ctx.notes.at(-1).msg.includes("HERDR_ENV"), ctx.notes.at(-1).msg);
      await pi.commands.delegate.handler("scout Owner outcome: go", ctx);
      assert.equal(ctx.notes.at(-1).level, "error", String(bad));
      assert.ok(ctx.notes.at(-1).msg.includes("HERDR_ENV"), ctx.notes.at(-1).msg);
      assert.equal(pi.execCalls.length, 0, String(bad));
    });
  }
});

test("outside Herdr (unset/empty/non-1): /ws is refused before the planning model call", async () => {
  for (const bad of OUTSIDE_HERDR) {
    await withHerdrEnv(bad, () =>
      withWsConfig({ workos: "~/work/workos" }, async () => {
        const pi = makePi({ execImpl: wsExec([]) });
        herdrFleet(pi);
        const ctx = makeCtx();
        let modelCalled = false;
        ctx.modelRegistry = {
          getApiKeyAndHeaders: async () => {
            modelCalled = true;
            return { ok: true };
          },
          getProvider: () => ({
            stream: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"name":"fix-flaky-tests","repo":null}' }] }) }),
          }),
        };
        // multi-word purpose: without the early /ws guard this reaches the model before any herdr call
        await pi.commands.ws.handler("workos fix the flaky tests", ctx);
        assert.equal(ctx.notes[0].level, "error", String(bad));
        assert.ok(ctx.notes[0].msg.includes("HERDR_ENV"), ctx.notes[0].msg);
        assert.equal(modelCalled, false, "no tokens spent outside Herdr");
        assert.equal(pi.execCalls.length, 0, String(bad));
      }),
    );
  }
});

// herdr --skill: agent names must match [a-z][a-z0-9_-]{0,31} and be unique among live agents.
test("/delegate: illegal agent names are refused before anything is spawned", async () => {
  const pi = makePi({ execImpl: delegateExec([ME]) });
  herdrFleet(pi);
  for (const bad of ["1scout", "Scout", "-x", "a".repeat(33)]) {
    const ctx = fleetCtx();
    await pi.commands.delegate.handler(`${bad} Owner outcome: go`, ctx);
    assert.equal(ctx.notes.at(-1).level, "error", bad);
    assert.ok(ctx.notes.at(-1).msg.includes("[a-z][a-z0-9_-]"), ctx.notes.at(-1).msg);
  }
  assert.equal(pi.execCalls.length, 0);
});

test("/delegate: 32-char and underscored names are legal; a 32-char collision keeps the suffixed name within 32", async () => {
  const taken32 = `a${"b".repeat(31)}`;
  const pi = makePi({ execImpl: delegateExec([ME, { name: taken32, pane_id: "w2:p9", workspace_id: "w2" }]) });
  herdrFleet(pi);
  await pi.commands.delegate.handler("my_agent Owner outcome: go", fleetCtx());
  assert.equal(calls(pi)[2][3], "my_agent");
  const pi2 = makePi({ execImpl: delegateExec([ME, { name: taken32, pane_id: "w2:p9", workspace_id: "w2" }]) });
  herdrFleet(pi2);
  await pi2.commands.delegate.handler(`${taken32} Owner outcome: go`, fleetCtx());
  const used = calls(pi2)[2][3];
  assert.notEqual(used, taken32);
  assert.equal(used.length, 32, used);
  assert.match(used, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(calls(pi2)[3][3], "wH:p2", "prompt targets the returned pane");
});

test("/ws with explicit dir: legal names gain Coordinator suffix; illegal names rejected before planning; multi-word purposes still plan", () =>
  withWsConfig({ workos: "~/work/workos" }, async () => {
    const slug32 = `a${"b".repeat(31)}`;
    const pi = makePi({ execImpl: wsExec([]) });
    herdrFleet(pi);
    const ctx = makeCtx();
    let modelCalls = 0;
    ctx.modelRegistry = {
      getApiKeyAndHeaders: async () => {
        modelCalls += 1;
        return { ok: true };
      },
      getProvider: () => ({
        stream: () => ({
          result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"name":"3D Printing Fix For The Flaky CI Suite","repo":null}' }] }),
        }),
      }),
    };
    await pi.commands.ws.handler(`workos ${slug32}`, ctx);
    assert.equal(modelCalls, 0, "a legal 32-char slug needs no model call");
    assert.equal(calls(pi)[2][3], `a${"b".repeat(19)}-coordinator`);
    await pi.commands.ws.handler("workos my_agent", ctx);
    assert.equal(modelCalls, 0, "an underscored single-token name is legal");
    assert.equal(calls(pi)[5][3], "my_agent-coordinator");
    for (const bad of ["3d-printing-fix", "a".repeat(33), "FixFlaky"]) {
      const before = pi.execCalls.length;
      await pi.commands.ws.handler(`workos ${bad}`, ctx);
      const note = ctx.notes.at(-1);
      assert.equal(note.level, "error", bad);
      assert.ok(note.msg.includes("[a-z][a-z0-9_-]"), note.msg);
      assert.equal(modelCalls, 0, `${bad}: an illegal explicit name must not be silently replaced by a model-chosen one`);
      assert.equal(pi.execCalls.length, before, `${bad}: nothing created`);
    }
    await pi.commands.ws.handler("workos fix the 3d printing flakes", ctx);
    assert.equal(modelCalls, 1, "a multi-word hint is a purpose, not a name — the model plans");
    const generated = calls(pi).at(-1)[3];
    assert.match(generated, /^[a-z][a-z0-9_-]{0,31}$/, generated);
    assert.ok(generated.length <= 32, generated);
  }));

// A listed name can be claimed by someone else between agent list and agent start; recovery must
// inspect the pane this run actually got back (here the collision-suffixed scout-2 in wH:p2).
const collisionExec = (failOn: string) => async (_c: string, args: string[]) => {
  if (args[1] === "list") return agentsReply([ME, { name: "scout", pane_id: "w2:p7", workspace_id: "w2" }]);
  if (args[0] === "tab") return tabReply;
  if (args[1] === failOn) return { code: 1, stdout: "", stderr: failOn === "start" ? "agent_not_ready" : "agent_prompt_stalled" };
  return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
};

test("/delegate: agent start failure keeps the raw error and points inspection at the returned pane, not the name", async () => {
  const pi = makePi({ execImpl: collisionExec("start") });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("scout Owner outcome: go", ctx);
  const note = ctx.notes.at(-1);
  assert.equal(note.level, "error");
  assert.ok(note.msg.includes("agent_not_ready"), note.msg);
  assert.ok(note.msg.includes("scout-2"), "the actual collision-suffixed child");
  assert.ok(note.msg.includes("herdr agent get wH:p2"), `pane-targeted inspect: ${note.msg}`);
  assert.ok(note.msg.includes("herdr agent read wH:p2 --source recent-unwrapped"), note.msg);
  assert.ok(!note.msg.includes("agent get scout"), "never inspects a possibly-claimed name");
  assert.ok(!note.msg.includes("tab close"), "never steers toward closing possibly-live work");
});

test("/delegate: prompt failure warns that a stall is not proof of non-delivery and inspects by pane", async () => {
  const pi = makePi({ execImpl: collisionExec("prompt") });
  herdrFleet(pi);
  const ctx = fleetCtx();
  await pi.commands.delegate.handler("scout Owner outcome: go", ctx);
  const note = ctx.notes.at(-1);
  assert.equal(note.level, "error");
  assert.ok(note.msg.includes("agent_prompt_stalled"), note.msg);
  assert.ok(note.msg.includes("scout-2"), note.msg);
  assert.ok(note.msg.includes("herdr agent get wH:p2"), note.msg);
  assert.ok(/not proof|does not prove/.test(note.msg), note.msg);
});

test("/ws: agent start failure names the new workspace child and pane for inspection", () =>
  withWsConfig({ workos: "~/work/workos" }, async () => {
    const pi = makePi({
      execImpl: async (_c: string, args: string[]) => {
        if (args[0] === "agent" && args[1] === "list") return agentsReply([]);
        if (args[0] === "workspace") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "p3" } } }), stderr: "" };
        return { code: 1, stdout: "", stderr: "agent_not_ready" };
      },
    });
    herdrFleet(pi);
    const ctx = makeCtx();
    await pi.commands.ws.handler("workos fix-flaky-tests", ctx);
    const note = ctx.notes.at(-1);
    assert.equal(note.level, "error");
    assert.ok(note.msg.includes("fix-flaky-tests"), note.msg);
    assert.ok(note.msg.includes("herdr agent get p3"), note.msg);
    assert.ok(note.msg.includes("herdr agent read p3 --source recent-unwrapped"), note.msg);
  }));

test("launch_agent and /delegate share effective cwd, unique names, parent, topology and owner bytes", async () => {
  const task = "Owner outcome:\nKeep `this` exactly.\n\nDerived design: small slice.";
  const directory = realpathSync.native(linkedTaskDir());
  try {
    const runs = [];
    for (const human of [true, false]) {
      const pi = makePi({ execImpl: delegateExec([ME, { name: "lead" }]) });
      const ctx = fleetCtx();
      pi.events.on("pi-change-working-dir:resolve-execution-cwd", (request: { sessionManager: unknown; result?: { cwd: string } }) => {
        assert.equal(request.sessionManager, ctx.sessionManager);
        request.result = { cwd: directory };
      });
      herdrFleet(pi);
      if (human) await pi.commands.delegate.handler(`lead ${task}`, ctx);
      else {
        assert.ok(pi.tools.launch_agent, "distinct model-callable launcher");
        assert.equal(pi.tools.delegate, undefined, "pi-subagents owns delegate");
        const result = await pi.tools.launch_agent.execute("launch", { name: "lead", task }, undefined, undefined, ctx);
        assert.notEqual(result.details.cwd, directory);
        assert.equal(result.details.sourceCwd, directory);
        assert.equal(result.details.parent, MY_ID);
      }
      assert.equal(pi.state.entries[0].data.sourceCwd, directory, "effective repository, not stale session/process cwd");
      assert.notEqual(calls(pi)[1][6], directory, "Coder gets a new worktree");
      assert.ok(calls(pi)[1].includes("--no-focus"));
      assert.ok(calls(pi)[1].includes(`PI_SPAWNED_BY=${MY_ID}`));
      assert.equal(calls(pi)[2][3], "lead-2");
      assert.ok(calls(pi)[3][4].startsWith(`${task}\n\n`), "verbatim task");
      assert.ok(!calls(pi).flat().includes("--approve"));
      assert.match(readFileSync(calls(pi)[2][calls(pi)[2].indexOf("--append-system-prompt") + 1], "utf8"), /three.*rounds/i);
      assert.match(calls(pi)[2].at(-1), /publishing|publish/);
      runs.push(calls(pi));
    }
    assert.deepEqual(comparableTransport(runs[0]), comparableTransport(runs[1]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("role config independently selects model, effort and instructions without changing global defaults", async () => {
  const configDir = linkedTaskDir();
  const settingsBefore = readFileSync(join(sourceAgentDir, "settings.json"), "utf8");
  mkdirSync(join(configDir, "configs"));
  writeFileSync(join(configDir, "configs/session-roles.json"), JSON.stringify({
    coder: { model: "example/coder", thinking: "low", instructionsFile: "coder.md" },
    coordinator: { model: "example/coordinator", thinking: "max", instructionsFile: "coordinator.md" },
  }));
  writeFileSync(join(configDir, "configs/coder.md"), "Coder selected instructions.\nFull multiline body.\n");
  writeFileSync(join(configDir, "configs/coordinator.md"), "Coordinator selected instructions.\nFull multiline body.\n");
  setAgentDir(configDir);
  try {
    for (const [role, model, thinking] of [["coder", "example/coder", "low"], ["coordinator", "example/coordinator", "max"]]) {
      const launches = [];
      for (const human of [true, false]) {
        const pi = makePi({ execImpl: delegateExec([ME]) });
        herdrFleet(pi);
        if (human) await pi.commands.delegate.handler(`--role ${role} lead Owner outcome: do thing`, fleetCtx());
        else await pi.tools.launch_agent.execute("role", { name: "lead", task: "Owner outcome: do thing", role }, undefined, undefined, fleetCtx());
        const start = calls(pi)[2];
        assert.ok(start, "profile selected and launched");
        assert.equal(start[start.indexOf("--model") + 1], model);
        assert.equal(start[start.indexOf("--thinking") + 1], thinking);
        assert.ok(readFileSync(start[start.indexOf("--append-system-prompt") + 1], "utf8").includes(`${role === "coder" ? "Coder" : "Coordinator"} selected instructions.`));
        assert.match(start.at(-1), /Mode: delegated/);
        assert.ok(calls(pi)[1].includes(`PI_CODING_AGENT_DIR=${configDir}`));
        assert.ok(calls(pi)[1].includes(`PI_SPAWNED_BY=${MY_ID}`));
        assert.ok(start.at(-1).includes(MY_ID));
        assert.match(start.at(-1), /authority/i);
        assert.match(start.at(-1), /paused/i);
        launches.push(calls(pi));
      }
      assert.deepEqual(comparableTransport(launches[0]), comparableTransport(launches[1]));
    }
    const ws = makePi({ execImpl: wsExec([]) });
    herdrFleet(ws);
    await ws.commands.ws.handler(`${configDir} profile-coordinator`, fleetCtx());
    const interactive = calls(ws)[2];
    assert.equal(interactive[interactive.indexOf("--model") + 1], "example/coordinator");
    assert.equal(interactive[interactive.indexOf("--thinking") + 1], "max");
    assert.match(interactive.at(-1), /interactive/);
    assert.ok(!interactive.at(-1).includes(MY_ID));
    assert.ok(calls(ws)[1].includes(`PI_CODING_AGENT_DIR=${configDir}`));
    assert.equal(readFileSync(join(sourceAgentDir, "settings.json"), "utf8"), settingsBefore);
  } finally {
    setAgentDir(sourceAgentDir);
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("launch_agent rejects invalid intent, names, modes, cwd and resolver errors before spawn", async () => {
  for (const params of [
    { name: "lead", task: "paraphrase" },
    { name: "Bad", task: "Owner outcome: go" },
    { name: "lead", role: "unknown", task: "Owner outcome: go" },
    { name: "lead", role: "coder", mode: "interactive", task: "Owner outcome: go" },
    { name: "lead", cwd: "/nonexistent-fleet-cwd", task: "Owner outcome: go" },
    { name: "lead", noProjectResources: "false", task: "Owner outcome: go" },
  ]) {
    const pi = makePi({ execImpl: delegateExec([ME]) });
    herdrFleet(pi);
    await assert.rejects(() => pi.tools.launch_agent.execute("bad", params, undefined, undefined, fleetCtx()));
    assert.equal(pi.execCalls.length, 0);
  }
  for (const result of [{ cwd: "/gone", error: "Working directory unavailable" }, { cwd: "relative" }]) {
    const pi = makePi({ execImpl: delegateExec([ME]) });
    pi.events.on("pi-change-working-dir:resolve-execution-cwd", (request: { result?: unknown }) => { request.result = result; });
    herdrFleet(pi);
    await assert.rejects(() => pi.tools.launch_agent.execute("cwd", { name: "lead", task: "Owner outcome: go" }, undefined, undefined, fleetCtx()));
    assert.equal(pi.execCalls.length, 0);
  }
});

test("launch_agent preserves uncertain start/delivery errors without retry or closing the pane", async () => {
  for (const phase of ["start", "prompt"]) {
    const pi = makePi({ execImpl: collisionExec(phase) });
    herdrFleet(pi);
    await assert.rejects(
      () => pi.tools.launch_agent.execute("uncertain", { name: "scout", task: "Owner outcome: go" }, undefined, undefined, fleetCtx()),
      /pane wH:p2.*do not resubmit blindly/,
    );
    assert.equal(calls(pi).filter((args: string[]) => args[2] === phase).length, 1);
    assert.equal(calls(pi).length, phase === "start" ? 3 : 4);
    assert.ok(!calls(pi).flat().includes("close"));
  }
});

test("explicit cwd is relative to the effective directory; unavailable change_dir owner fails closed", async () => {
  const directory = realpathSync.native(linkedTaskDir());
  git(directory, "worktree", "add", "-q", "-b", "nested", join(directory, "worktree"));
  try {
    for (const human of [true, false]) {
      const pi = makePi({ execImpl: delegateExec([ME]) });
      pi.events.on("pi-change-working-dir:resolve-execution-cwd", (request: { result?: { cwd: string } }) => { request.result = { cwd: directory }; });
      herdrFleet(pi);
      clearFixtureClaim(join(directory, "worktree"));
      if (human) await pi.commands.delegate.handler('--cwd "worktree" lead Owner outcome: go', fleetCtx());
      else await pi.tools.launch_agent.execute("dir", { name: "lead", task: "Owner outcome: go", cwd: "worktree" }, undefined, undefined, fleetCtx());
      assert.equal(calls(pi)[1][6], join(directory, "worktree"));
    }
    const pi = makePi({ execImpl: delegateExec([ME]) });
    pi.getAllTools = () => [{ name: "change_dir" }];
    herdrFleet(pi);
    await assert.rejects(
      () => pi.tools.launch_agent.execute("old-owner", { name: "lead", task: "Owner outcome: go" }, undefined, undefined, fleetCtx()),
      /update the extension and restart Pi/,
    );
    assert.equal(pi.execCalls.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid or missing source role profiles fail before any herdr call", async () => {
  const configDir = linkedTaskDir();
  mkdirSync(join(configDir, "configs"));
  writeFileSync(join(configDir, "configs/valid.md"), "Valid role instructions.\n");
  writeFileSync(join(configDir, "configs/empty.md"), "");
  setAgentDir(configDir);
  try {
    for (const [profile, error] of [
      [undefined, /missing coder profile/],
      [{ model: "gpt-6-astra", thinking: "high", instructionsFile: "valid.md" }, /qualified provider\/model/],
      [{ model: "provider/id", thinking: "extreme", instructionsFile: "valid.md" }, /thinking is invalid/],
      [{ model: "provider/id", thinking: "high", instructionsFile: "" }, /instructionsFile must name/],
      [{ model: "provider/id", thinking: "high", instructionsFile: "empty.md" }, /instruction file must be nonempty/],
    ] as const) {
      writeFileSync(join(configDir, "configs/session-roles.json"), JSON.stringify({ coder: profile }));
      const pi = makePi({ execImpl: delegateExec([ME]) });
      herdrFleet(pi);
      await assert.rejects(() => pi.tools.launch_agent.execute("profile", { name: "lead", task: "Owner outcome: go" }, undefined, undefined, fleetCtx()), error);
      assert.equal(pi.execCalls.length, 0);
    }
  } finally {
    setAgentDir(sourceAgentDir);
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("herdr startup transports full multiline role instructions through a file, with control-free argv", async () => {
  const pi = makePi({ execImpl: delegateExec([ME]) });
  herdrFleet(pi);
  await pi.commands.delegate.handler("lead Owner outcome: go", fleetCtx());
  const start = calls(pi)[2];
  assert.ok(start.every((arg: string) => !Array.from(arg).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  })), "herdr rejects controls in every agent-start argument");
  const appended = start.flatMap((arg: string, i: number) => arg === "--append-system-prompt" ? [start[i + 1]] : []);
  assert.equal(appended.length, 2);
  assert.match(readFileSync(appended[0], "utf8"), /Coder/);
  assert.match(appended[1], /Mode: delegated/);
  assert.ok(appended[1].includes(MY_ID));
});

test("multisegment native model IDs remain qualified while effort stays independent", async () => {
  const directory = linkedTaskDir();
  mkdirSync(join(directory, "configs"));
  const config = JSON.parse(readFileSync(join(sourceAgentDir, "configs/session-roles.json"), "utf8"));
  config.coder.model = "cloudflare-ai-gateway/accounts/fireworks/models/kimi-k3";
  config.coder.thinking = "low";
  writeFileSync(join(directory, "configs", config.coder.instructionsFile), readFileSync(join(sourceAgentDir, "configs", config.coder.instructionsFile)));
  writeFileSync(join(directory, "configs/session-roles.json"), JSON.stringify(config));
  setAgentDir(directory);
  try {
    for (const model of ["cloudflare-ai-gateway/accounts/fireworks/models/kimi-k3", "openrouter/meta-llama/llama-3.1-8b-instruct:free"]) {
      config.coder.model = model;
      writeFileSync(join(directory, "configs/session-roles.json"), JSON.stringify(config));
      const pi = makePi({ execImpl: delegateExec([ME]) });
      herdrFleet(pi);
      const result = await pi.tools.launch_agent.execute("model", { name: "lead", task: "Owner outcome: go" }, undefined, undefined, fleetCtx());
      assert.equal(result.details.model, model);
      assert.equal(result.details.thinking, "low");
      assert.equal(calls(pi)[2][calls(pi)[2].indexOf("--thinking") + 1], "low");
    }
  } finally {
    setAgentDir(sourceAgentDir);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace prose and explicit directories recover from vanished cwd; delegated defaults stay fail-closed", async () => {
  const directory = realpathSync.native(linkedTaskDir());
  try {
    const pi = makePi({ execImpl: delegateExec([ME]) });
    pi.events.on("pi-change-working-dir:resolve-execution-cwd", (request: { result?: unknown }) => {
      request.result = { cwd: "/gone", error: "Working directory unavailable" };
    });
    herdrFleet(pi);
    const result = await pi.tools.launch_agent.execute("recover", { name: "lead", cwd: directory, task: "Owner outcome: go" }, undefined, undefined, fleetCtx());
    assert.equal(result.details.cwd, directory);
    for (const cwd of [undefined, "."]) {
      await assert.rejects(pi.tools.launch_agent.execute("missing", { name: "lead", cwd, task: "Owner outcome: go" }, undefined, undefined, fleetCtx()), /Working directory unavailable/);
    }
    await withWsConfig({ recovery: directory }, async () => {
      const ws = makePi({ execImpl: wsExec([]) });
      ws.events.on("pi-change-working-dir:resolve-execution-cwd", () => { throw new Error("resolver must not run"); });
      herdrFleet(ws);
      await ws.commands.ws.handler("recovery fix-recovery", fleetCtx());
      assert.equal(calls(ws)[1][4], directory);
      await ws.commands.ws.handler(`${directory} fix-direct`, fleetCtx());
      assert.equal(calls(ws)[4][4], directory);
      const prose = makePi({ execImpl: wsExec([]) });
      prose.events.on("pi-change-working-dir:resolve-execution-cwd", (request: { result?: unknown }) => {
        request.result = { cwd: "/gone", error: "Working directory unavailable" };
      });
      herdrFleet(prose);
      const ctx = fleetCtx();
      ctx.modelRegistry = {
        getApiKeyAndHeaders: async () => ({ ok: true }),
        getProvider: () => ({ stream: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"name":"fix-flaky-tests","repo":"recovery"}' }] }) }) }),
      };
      await prose.commands.ws.handler("fix the flaky mac tests", ctx);
      assert.notEqual(ctx.notes.at(-1)?.level, "error", ctx.notes.at(-1)?.msg);
      assert.equal(calls(prose)[1][4], directory);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Coordinator suffix and collision space are reserved once; task delivery targets its pane", async () => {
  const wanted = `a${"b".repeat(31)}`;
  const first = `a${"b".repeat(19)}-coordinator`;
  const second = `a${"b".repeat(17)}-coordinator-2`;
  const pi = makePi({ execImpl: delegateExec([ME, { name: first }]) });
  herdrFleet(pi);
  const result = await pi.tools.launch_agent.execute("name", { name: wanted, role: "coordinator", task: "Owner outcome: go" }, undefined, undefined, fleetCtx());
  assert.equal(result.details.name, second);
  assert.equal(calls(pi)[1][8], second);
  assert.equal(calls(pi)[2][3], second);
  assert.equal(calls(pi)[2][12], second);
  assert.equal(calls(pi)[3][3], "wH:p2");
  for (const [name, expected, taken] of [
    ["topic-coordinator", "topic-coordinator", []],
    ["coordinator-3d-print", "coordinator-3d-print", []],
    ["coordinator-3d-print", "coordinator-3d-print-2", ["coordinator-3d-print"]],
    [`coordinator-${"3".repeat(20)}`, `coordinator-${"3".repeat(18)}-2`, [`coordinator-${"3".repeat(20)}`]],
  ] as const) {
    const existing = makePi({ execImpl: delegateExec([ME, ...taken.map((used) => ({ name: used }))]) });
    herdrFleet(existing);
    const kept = await existing.tools.launch_agent.execute("component", { name, role: "coordinator", task: "Owner outcome: go" }, undefined, undefined, fleetCtx());
    assert.equal(kept.details.name, expected);
    assert.match(kept.details.name, /^[a-z][a-z0-9_-]{0,31}$/);
    assert.equal(kept.details.name.match(/coordinator/g)?.length, 1);
  }
});

test("unresolved native project trust prevents creation and delivery; explicit opt-out cannot approve it", async () => {
  const directory = realpathSync.native(linkedTaskDir());
  mkdirSync(join(directory, ".pi"));
  writeFileSync(join(directory, ".pi/settings.json"), "{}");
  try {
    for (const human of [true, false]) {
      clearFixtureClaim(directory);
      const pi = makePi({ execImpl: delegateExec([ME]) });
      herdrFleet(pi);
      const ctx = fleetCtx();
      if (human) {
        await pi.commands.delegate.handler(`--cwd "${directory}" lead Owner outcome: go`, ctx);
        assert.match(ctx.notes.at(-1).msg, /trust.*decision/i);
      } else await assert.rejects(
        () => pi.tools.launch_agent.execute("trust", { name: "lead", cwd: directory, task: "Owner outcome: go" }, undefined, undefined, ctx),
        /trust.*decision/i,
      );
      assert.ok(calls(pi).every((call: string[]) => call[1] === "agent" && call[2] === "list"), "no pane, start or task Enter");
    }
    const optOutCalls = [];
    for (const human of [true, false]) {
      clearFixtureClaim(directory);
      const pi = makePi({ execImpl: delegateExec([ME]) });
      herdrFleet(pi);
      if (human) await pi.commands.delegate.handler(`--no-approve --cwd "${directory}" lead Owner outcome: go`, fleetCtx());
      else await pi.tools.launch_agent.execute("opt-out", { name: "lead", cwd: directory, task: "Owner outcome: go", noProjectResources: true }, undefined, undefined, fleetCtx());
      assert.ok(calls(pi)[2].includes("--no-approve"));
      assert.ok(!calls(pi).flat().includes("--approve"));
      optOutCalls.push(calls(pi));
    }
    assert.deepEqual(optOutCalls[0], optOutCalls[1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("leaf marker omits pane tool and refuses the shared command boundary; only /ws is interactive", async () => {
  const registeredParent = makePi({ execImpl: delegateExec([ME]) });
  herdrFleet(registeredParent);
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    await assert.rejects(
      () => registeredParent.tools.launch_agent.execute("cached-tool", { name: "lead", task: "Owner outcome: go" }, undefined, undefined, fleetCtx()),
      /leaf.*subagent/i,
    );
    assert.equal(registeredParent.execCalls.length, 0);
    const pi = makePi({ execImpl: delegateExec([ME]) });
    herdrFleet(pi);
    assert.equal(pi.tools.launch_agent, undefined);
    const ctx = fleetCtx();
    await pi.commands.delegate.handler("lead Owner outcome: go", ctx);
    assert.match(ctx.notes.at(-1).msg, /leaf|subagent/i);
    assert.equal(pi.execCalls.length, 0);
  } finally {
    delete process.env.PI_SUBAGENT_CHILD;
  }
  for (const human of [true, false]) {
    const pi = makePi({ execImpl: delegateExec([ME]) });
    herdrFleet(pi);
    const ctx = fleetCtx();
    if (human) {
      await pi.commands.delegate.handler("--role coordinator --mode interactive lead Owner outcome: go", ctx);
      assert.match(ctx.notes.at(-1).msg, /delegated|interactive.*ws/i);
    } else await assert.rejects(
      () => pi.tools.launch_agent.execute("mode", { name: "lead", role: "coordinator", mode: "interactive", task: "Owner outcome: go" }, undefined, undefined, ctx),
      /delegated|interactive.*ws/i,
    );
    assert.equal(pi.execCalls.length, 0);
  }
});

test("native saved trust decisions take precedence over policy; policy never and explicit opt-out decline resources", async () => {
  const directory = realpathSync.native(linkedTaskDir());
  const configDir = join(directory, "agent");
  mkdirSync(join(configDir, "configs"), { recursive: true });
  mkdirSync(join(directory, "project/.pi"), { recursive: true });
  const cwd = join(directory, "project");
  writeFileSync(join(cwd, ".pi/settings.json"), "{}");
  const config = JSON.parse(readFileSync(join(sourceAgentDir, "configs/session-roles.json"), "utf8"));
  writeFileSync(join(configDir, "configs/session-roles.json"), JSON.stringify(config));
  writeFileSync(join(configDir, "configs", config.coder.instructionsFile), readFileSync(join(sourceAgentDir, "configs", config.coder.instructionsFile)));
  setAgentDir(configDir);
  try {
    for (const [decision, policy, declined] of [
      [true, "ask", false],
      [false, "always", true],
      [null, "never", true],
      [null, "always", false],
    ] as const) {
      clearFixtureClaim(cwd);
      writeFileSync(join(configDir, "settings.json"), JSON.stringify({ defaultProjectTrust: policy }));
      // Simulated pre-existing decisions only; no native trust approval action.
      const stored = JSON.stringify(decision === null ? {} : { [directory]: decision });
      writeFileSync(join(configDir, "trust.json"), stored);
      const pi = makePi({ execImpl: delegateExec([ME]) });
      herdrFleet(pi);
      await pi.tools.launch_agent.execute("policy", { name: "lead", cwd, task: "Owner outcome: go" }, undefined, undefined, fleetCtx());
      assert.ok(calls(pi)[1].includes(`PI_CODING_AGENT_DIR=${configDir}`), "herdr requires explicit env; child must read the preflight's config");
      assert.equal(calls(pi)[2].includes("--no-approve"), declined);
      assert.ok(!calls(pi).flat().includes("--approve"));
      assert.equal(readFileSync(join(configDir, "trust.json"), "utf8"), stored);
    }
  } finally {
    setAgentDir(sourceAgentDir);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new unresolved trust during creation or startup preserves Pi and never sends task Enter", async () => {
  const directory = realpathSync.native(linkedTaskDir());
  try {
    for (const phase of ["tab", "start"]) {
      clearFixtureClaim(directory);
      const pi = makePi({ execImpl: async (cmd: string, args: string[]) => {
        if ((phase === "tab" && args[0] === "tab") || (phase === "start" && args[0] === "agent" && args[1] === "start")) {
          mkdirSync(join(directory, ".pi"));
          writeFileSync(join(directory, ".pi/settings.json"), "{}");
        }
        return delegateExec([ME])(cmd, args);
      } });
      herdrFleet(pi);
      await assert.rejects(
        () => pi.tools.launch_agent.execute("race", { name: "lead", cwd: directory, task: "Owner outcome: go" }, undefined, undefined, fleetCtx()),
        /Keep pane wH:p2.*Pi.*editor.*never.*shell.*Do not retry/,
      );
      assert.equal(calls(pi).length, 3, "Pi start occurs before editor recovery; no bare-shell paste instruction");
      assert.equal(calls(pi)[2][2], "start");
      assert.ok(!calls(pi).some((args: string[]) => args[2] === "prompt" || args.includes("close")));
      rmSync(join(directory, ".pi"), { recursive: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/ws leaves native trust to the human, pins agent dir, and sends no input", async () => {
  const directory = realpathSync.native(linkedTaskDir());
  mkdirSync(join(directory, ".pi"));
  writeFileSync(join(directory, ".pi/settings.json"), "{}");
  try {
    for (const optOut of [false, true]) {
      const pi = makePi({ execImpl: wsExec([]) });
      herdrFleet(pi);
      const ctx = fleetCtx();
      await pi.commands.ws.handler(`${optOut ? "--no-approve " : ""}${directory} human-coordinator`, ctx);
      assert.equal(ctx.notes.at(-1).level, "info");
      assert.equal(calls(pi)[1][2], "create");
      assert.ok(calls(pi)[1].includes(`PI_CODING_AGENT_DIR=${sourceAgentDir}`));
      assert.ok(!calls(pi)[1].includes("--no-focus"));
      assert.ok(!calls(pi)[1].some((arg: string) => arg.startsWith("PI_SPAWNED_BY=")));
      assert.equal(calls(pi)[2].includes("--no-approve"), optOut);
      assert.ok(!calls(pi).flat().includes("--approve"));
      assert.equal(calls(pi).length, 3, "no prompt, keys or task Enter");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
