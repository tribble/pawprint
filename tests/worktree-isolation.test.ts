import { after, mock, test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import herdrFleet from "../extensions/herdr-fleet.ts";
import { fleetParent, fleetRepo } from "./fleet-fixture.ts";
import { git, mktmp } from "./fixture.ts";
import { setAgentDir } from "./stubs/pi-coding-agent.mjs";

setAgentDir(new URL("../agent", import.meta.url).pathname);
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "wT:p1";
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_INTERCOM_ROOT_SESSION_ID;
delete process.env.PI_INTERCOM_PARENT_SESSION_ID;
delete process.env.PAWPRINT_FLEET_LEAF;
delete process.env.PI_INTERCOM_SESSION_ID;
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

function managedParent(source: string, cwd: string, callerCwd = source) {
  const parent = fleetParent(callerCwd);
  parent.workspaces.push({ workspace_id: "wT" }, {
    workspace_id: "wN",
    worktree: {
      checkout_path: cwd, repo_key: git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      repo_root: source, repo_name: "source", is_linked_worktree: true,
    },
  });
  return parent;
}

async function deliveryOwner(nativeError = "", failedPhase = "prompt") {
  const { source, cwd } = linked();
  const parent = managedParent(source, cwd);
  if (nativeError) {
    const exec = parent.pi.execImpl;
    parent.pi.execImpl = async (cmd: string, args: string[]) => {
      const result = await exec(cmd, args);
      return cmd === "herdr" && args[1] === failedPhase
        ? { code: 1, stdout: "", stderr: nativeError, killed: false } : result;
    };
  }
  herdrFleet(parent.pi);
  const admission = launch(parent, { role: "delivery-lead", cwd });
  if (nativeError) await assert.rejects(admission, new RegExp(nativeError));
  else await admission;
  const record = parent.pi.state.entries.at(-1).data;
  const owner = fleetParent(cwd, record.childSessionId);
  const nativeOwner = parent.roster.at(-1);
  assert.ok(nativeOwner);
  const nativeFile = (nativeOwner.agent_session as { value: string }).value;
  owner.roster[0] = { ...nativeOwner };
  owner.workspaces.push(...parent.workspaces);
  owner.ctx.sessionManager.getSessionFile = () => nativeFile;
  process.env.HERDR_PANE_ID = "wN:p2";
  return { parent, owner, cwd };
}

test("launch acknowledges one PTY submission without requiring observed task activity", async () => {
  const { source, cwd } = linked();
  const parent = managedParent(source, cwd);
  const exec = parent.pi.execImpl;
  parent.pi.execImpl = async (cmd: string, args: string[]) => {
    if (cmd === "herdr" && args[1] === "prompt") {
      if (args.includes("--wait")) return { code: 1, stdout: "", stderr: "agent_prompt_stalled", killed: false };
      // Herdr acknowledges PTY writes even when Pi has not consumed the task yet.
      return { code: 0, stdout: JSON.stringify({ result: { agent: { ...parent.roster.at(-1) } } }), stderr: "", killed: false };
    }
    const result = await exec(cmd, args);
    if (cmd === "herdr" && args[1] === "start") {
      const child = parent.roster.at(-1);
      assert.ok(child);
      child.agent_status = "idle";
    }
    return result;
  };
  herdrFleet(parent.pi);
  const result = await launch(parent, { role: "delivery-lead", cwd });
  assert.match(result.content[0].text, /PTY writes acknowledged/);
  assert.match(result.content[0].text, /consumption and execution.*unverified/i);
  const native = parent.pi.execCalls.filter((call: string[]) => call[0] === "herdr" && ["start", "get", "prompt"].includes(call[2]));
  assert.deepEqual(native.map((call: string[]) => call[2]), ["start", "get", "prompt", "get"]);
  assert.equal(native[2][4].startsWith(task), true);
  const child = parent.roster.at(-1);
  assert.ok(child);
  assert.equal(existsSync((child.agent_session as { value: string }).value), false, "acknowledgement does not require a saved task");
  assert.equal(parent.pi.state.entries.at(-1).data.phase, "prompted");
});

test("code-leaf admission follows current native identity, never the parent's launch history", async (t) => {
  for (const scenario of ["original", "changed-uncertain-binding", "pane", "foreign-uuid", "copied-owner", "tree", "native"]) {
    await t.test(scenario, async () => {
      try {
        const error = "agent_prompt_stalled";
        const { parent, owner, cwd } = await deliveryOwner(error);
        const parentFile = parent.ctx.sessionManager.getSessionFile();
        const history = readFileSync(parentFile, "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
        const uncertain = history.at(-1);
        assert.equal(uncertain.data.phase, "uncertain");
        assert.match(uncertain.data.error, new RegExp(error));
        if (scenario === "changed-uncertain-binding") {
          Object.assign(uncertain.data, { childSessionId: "foreign", ownerSessionId: "foreign", ownerSessionFile: "/foreign",
            cwd: "/foreign", worktreeKey: "/foreign", paneId: "foreign" });
        }
        if (scenario === "foreign-uuid") {
          owner.ctx.sessionManager.getSessionId = () => "foreign";
          uncertain.data.childSessionId = "foreign";
        }
        writeFileSync(parentFile, history.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
        if (scenario === "copied-owner") {
          const copy = join(cwd, "copied-owner.jsonl");
          writeFileSync(copy, readFileSync(owner.ctx.sessionManager.getSessionFile()));
          owner.ctx.sessionManager.getSessionFile = () => copy;
        }
        if (scenario === "native") owner.roster[0].agent_session = { kind: "id", value: "foreign" };
        if (scenario === "pane") {
          process.env.HERDR_PANE_ID = "wN:p9";
          owner.roster[0].pane_id = "wN:p9";
        }
        const admittedCwd = scenario === "tree" ? linked().cwd : cwd;
        if (scenario === "tree") owner.ctx.cwd = admittedCwd;
        const before = readFileSync(parentFile, "utf8");
        herdrFleet(owner.pi);
        if (["original", "changed-uncertain-binding", "pane"].includes(scenario)) {
          const worker = await launch(owner, { role: "worker", cwd });
          assert.equal(worker.details.parent, owner.ctx.sessionManager.getSessionId());
          assert.equal(worker.details.cwd, cwd);
        } else {
          await assert.rejects(() => launch(owner, { role: "worker", cwd: admittedCwd }), /identity|header|same.*tree/i);
          assert.equal(paneMutations(owner).length, 0);
        }
        assert.equal(readFileSync(parentFile, "utf8"), before, "admission preserves original failure evidence");
      } finally {
        process.env.HERDR_PANE_ID = "wT:p1";
      }
    });
  }
});

test("fresh post-prompt native identity is required even when the acknowledgement returns the old snapshot", async (t) => {
  for (const scenario of ["mismatch", "missing"]) {
    await t.test(scenario, async () => {
      const { source, cwd } = linked();
      const parent = managedParent(source, cwd);
      const exec = parent.pi.execImpl;
      let submitted = false;
      parent.pi.execImpl = async (cmd: string, args: string[]) => {
        if (cmd === "herdr" && args[1] === "get" && submitted) return {
          code: 0, stdout: JSON.stringify({ result: scenario === "missing" ? {} : { agent: { agent_session: { kind: "id", value: "foreign" } } } }),
          stderr: "", killed: false,
        };
        const result = await exec(cmd, args);
        if (cmd === "herdr" && args[1] === "prompt") {
          submitted = true;
          return { ...result, stdout: JSON.stringify({ result: { agent: { ...parent.roster.at(-1) } } }) };
        }
        return result;
      };
      herdrFleet(parent.pi);
      await assert.rejects(() => launch(parent, { role: "delivery-lead", cwd }), /Native child session identity.*missing or mismatched/);
      assert.equal(paneMutations(parent).filter((call: string[]) => call[2] === "prompt").length, 1);
      assert.deepEqual(parent.pi.state.entries.slice(-2).map((entry: { data: { phase: string } }) => entry.data.phase), ["started", "uncertain"]);
      assert.match(parent.pi.state.entries.at(-1).data.error, /Native child session identity/);
    });
  }
});

test("native delivery owner launches sequential fresh code leaves in its admitted tree", async () => {
  try {
    const { owner, cwd } = await deliveryOwner();
    herdrFleet(owner.pi);
    for (const [role, model, thinking] of [
      ["worker", "cloudflare-ai-gateway/claude-opus-5-5", "high"],
      ["fixer", "cloudflare-ai-gateway/claude-opus-5-5", "low"],
      ["reviewer", "cloudflare-ai-gateway/gpt-6.1-sol", "xhigh"],
      ["reviewer-security", "cloudflare-ai-gateway/gpt-6.1-sol", "xhigh"],
    ]) {
      const result = await launch(owner, { name: role, role, cwd });
      const start = owner.pi.execCalls.findLast((call: string[]) => call[0] === "herdr" && call[2] === "start");
      assert.equal(start[start.indexOf("--model") + 1], model);
      assert.equal(start[start.indexOf("--thinking") + 1], thinking);
      assert.equal(result.details.cwd, cwd);
      assert.equal(result.details.parent, owner.ctx.sessionManager.getSessionId());
      assert.equal(result.details.claimPath, undefined);
      const prompt = owner.pi.execCalls.findLast((call: string[]) => call[0] === "herdr" && call[2] === "prompt")[4];
      assert.ok(prompt.startsWith(task));
      assert.match(prompt, /Remain idle/);
      const tab = owner.pi.execCalls.findLast((call: string[]) => call[0] === "herdr" && call[1] === "tab");
      assert.ok(tab.includes("PAWPRINT_FLEET_LEAF=1"));
      assert.notEqual(result.details.childSessionId, owner.ctx.sessionManager.getSessionId());
      await assert.rejects(() => launch(owner, { name: "duplicate", role, cwd }), /occupied|still live/i);
      owner.roster.length = 1;
    }
    assert.equal(owner.pi.execCalls.some((call: string[]) => call.includes("add") && call.includes("worktree")), false);
    assert.equal(existsSync(join(git(cwd, "rev-parse", "--absolute-git-dir"), "pawprint-writer.json")), false);
  } finally {
    process.env.HERDR_PANE_ID = "wT:p1";
  }
});

test("a fresh replacement main continues its settled predecessor's tree without the original launch record", async () => {
  try {
    const { parent, owner, cwd } = await deliveryOwner();
    herdrFleet(owner.pi);
    await launch(owner, { role: "worker", cwd });
    owner.roster.length = 1;
    const parentFile = parent.ctx.sessionManager.getSessionFile();
    const history = readFileSync(parentFile, "utf8");
    const replacement = fleetParent(cwd, "replacement");
    replacement.roster[0] = { ...replacement.roster[0], pane_id: "wN:p7", workspace_id: "wN" };
    replacement.roster.push(owner.roster[0]);
    replacement.workspaces.push(...parent.workspaces);
    process.env.HERDR_PANE_ID = "wN:p7";
    herdrFleet(replacement.pi);
    await assert.rejects(() => launch(replacement, { role: "worker", cwd }), /occupied by lead/);
    assert.equal(paneMutations(replacement).length, 0);
    replacement.roster.length = 1;
    const worker = await launch(replacement, { role: "worker", cwd });
    assert.equal(worker.details.cwd, cwd);
    assert.equal(worker.details.parent, "replacement");
    const tab = replacement.pi.execCalls.find((call: string[]) => call[0] === "herdr" && call[1] === "tab");
    assert.equal(tab[tab.indexOf("--workspace") + 1], "wN");
    assert.equal(readFileSync(parentFile, "utf8"), history, "takeover leaves the predecessor's launch history untouched");
  } finally {
    process.env.HERDR_PANE_ID = "wT:p1";
  }
});

test("review families select configured native models through both launch surfaces", async () => {
  try {
    const { owner, cwd } = await deliveryOwner();
    herdrFleet(owner.pi);
    const profiles = JSON.parse(readFileSync(new URL("../agent/configs/session-roles.json", import.meta.url), "utf8"));
    for (const role of ["reviewer", "reviewer-security"]) {
      for (const shortcut of [false, true]) {
        for (const [reviewFamily, model] of [
          [undefined, "cloudflare-ai-gateway/gpt-6.1-sol"],
          ["openai", "cloudflare-ai-gateway/gpt-6.1-sol"],
          ["anthropic", "cloudflare-ai-gateway/claude-opus-5-5"],
        ]) {
          if (shortcut) {
            await owner.pi.commands.delegate.handler(
              `--role ${role} ${reviewFamily ? `--review-family ${reviewFamily} ` : ""}--cwd "${cwd}" review ${task}`, owner.ctx);
            assert.equal(owner.ctx.notes.at(-1).level, "info");
          } else {
            const result = await launch(owner, { role, reviewFamily, cwd });
            assert.equal(result.details.model, model);
            assert.equal(result.details.thinking, "xhigh");
          }
          const start = owner.pi.execCalls.findLast((call: string[]) => call[0] === "herdr" && call[2] === "start");
          assert.equal(start[start.indexOf("--model") + 1], model);
          assert.equal(start[start.indexOf("--thinking") + 1], "xhigh");
          assert.equal(start[start.indexOf("--append-system-prompt") + 1],
            new URL("../agent/configs/delegation.md", import.meta.url).pathname);
          const prompt = owner.pi.execCalls.findLast((call: string[]) => call[0] === "herdr" && call[2] === "prompt")[4];
          assert.ok(prompt.startsWith(task));
          assert.ok(prompt.includes(`${role}: ${profiles[role].contract}`));
          owner.roster.length = 1;
        }
      }
    }
  } finally {
    process.env.HERDR_PANE_ID = "wT:p1";
  }
});

test("invalid review families and missing configured choices fail before native mutation", async () => {
  const directory = mktmp("review-config");
  mkdirSync(join(directory, "configs"));
  const sourceAgent = new URL("../agent", import.meta.url).pathname;
  const profiles = JSON.parse(readFileSync(join(sourceAgent, "configs/session-roles.json"), "utf8"));
  writeFileSync(join(directory, "configs/delegation.md"), readFileSync(join(sourceAgent, "configs/delegation.md")));
  try {
    const { owner, cwd } = await deliveryOwner();
    setAgentDir(directory);
    herdrFleet(owner.pi);
    for (const role of ["reviewer", "reviewer-security", "worker"]) {
      for (const [reviewFamily, choices, error] of [
        ["arbitrary/model", { anthropic: "cloudflare-ai-gateway/claude-opus-5-5" }, /reviewFamily must be/],
        ["anthropic", undefined, /reviewModels.*anthropic.*qualified/],
        ["anthropic", {}, /reviewModels.*anthropic.*qualified/],
        ["anthropic", { anthropic: "unqualified" }, /reviewModels.*anthropic.*qualified/],
        ["anthropic", { anthropic: "provider/model\n" }, /reviewModels.*anthropic.*qualified/],
      ] as const) {
        writeFileSync(join(directory, "configs/session-roles.json"), JSON.stringify({
          ...profiles, [role]: { ...profiles[role], reviewModels: choices },
        }));
        for (const shortcut of [false, true]) {
          const before = paneMutations(owner).length;
          const callsBefore = owner.pi.execCalls.length;
          const expected = role === "worker" ? /reviewFamily is only valid for reviewer/ : error;
          if (shortcut) {
            await owner.pi.commands.delegate.handler(
              `--role ${role} --review-family "${reviewFamily}" --cwd "${cwd}" review ${task}`, owner.ctx);
            assert.equal(owner.ctx.notes.at(-1).level, "error");
            assert.match(owner.ctx.notes.at(-1).msg, expected);
          } else {
            await assert.rejects(() => launch(owner, { role, reviewFamily, cwd }), expected);
          }
          assert.equal(paneMutations(owner).length, before);
          assert.equal(owner.pi.execCalls.length, callsBefore);
        }
      }
    }
  } finally {
    setAgentDir(sourceAgent);
    process.env.HERDR_PANE_ID = "wT:p1";
  }
});

test("code leaves refuse mismatched, occupied or uncertain admission before a second pane", async () => {
  for (const refusal of ["identity", "copied-session", "cwd", "occupied", "uncertain"]) {
    try {
      const { owner, cwd } = await deliveryOwner();
      if (refusal === "identity") owner.roster[0].agent_session = { kind: "id", value: "somebody-else" };
      if (refusal === "copied-session") {
        const copy = join(cwd, "copied-parent.jsonl");
        writeFileSync(copy, readFileSync(owner.ctx.sessionManager.getSessionFile()));
        owner.ctx.sessionManager.getSessionFile = () => copy;
      }
      if (refusal === "occupied") owner.roster.push({ pane_id: "wN:p9", cwd, name: "unknown" });
      herdrFleet(owner.pi);
      if (refusal === "uncertain") {
        const exec = owner.pi.execImpl;
        owner.pi.execImpl = (cmd: string, args: string[]) => cmd === "herdr" && args[1] === "start"
          ? Promise.resolve({ code: 1, stdout: "", stderr: "agent_not_ready", killed: false }) : exec(cmd, args);
        await assert.rejects(() => launch(owner, { role: "worker", cwd }), /agent_not_ready/);
        owner.roster.length = 1;
      }
      const before = paneMutations(owner).length;
      for (const params of [
        { role: "worker" },
        { role: "reviewer", reviewFamily: "anthropic" },
        { role: "reviewer-security", reviewFamily: "openai" },
      ]) {
        await assert.rejects(() => launch(owner, { ...params, cwd: refusal === "cwd" ? linked().cwd : cwd }),
          /admission|identity|same.*tree|occupied|uncertain/i);
      }
      assert.equal(paneMutations(owner).length, before);
    } finally {
      process.env.HERDR_PANE_ID = "wT:p1";
    }
  }
});

test("uncertain leaves keep unknown ownership global and scope only verified recorded trees", async (t) => {
  for (const scenario of ["same-tree", "unrelated-tree", "missing-key", "invalid-key", "mismatched-key", "mismatched-cwd", "missing-owner", "foreign-owner", "copied-file", "scout-without-key", "external-writer", "foreign-external-writer"]) {
    await t.test(scenario, async () => {
      const { source, cwd, dir } = linked();
      const other = join(dir, "other");
      git(source, "worktree", "add", "-q", "-b", "other", other);
      const external = externalDirectory();
      const parent = fleetParent(source);
      herdrFleet(parent.pi);
      const exec = parent.pi.execImpl;
      parent.pi.execImpl = (cmd: string, args: string[]) => cmd === "herdr" && args[1] === "start"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "agent_not_ready", killed: false }) : exec(cmd, args);
      const first = scenario.endsWith("external-writer") ? { role: "writer", externalOnly: true, cwd: external }
        : { role: scenario === "scout-without-key" ? "scout" : "fixer", cwd };
      await assert.rejects(() => launch(parent, first), /agent_not_ready/);
      parent.pi.execImpl = exec;
      for (const entry of parent.pi.state.entries as { data: Record<string, unknown> }[]) {
        if (scenario === "missing-key") delete entry.data.worktreeKey;
        if (scenario === "invalid-key") entry.data.worktreeKey = "not-a-recorded-tree";
        if (scenario === "mismatched-key") entry.data.worktreeKey = git(source, "rev-parse", "--absolute-git-dir");
        if (scenario === "mismatched-cwd") entry.data.cwd = other;
        if (scenario === "missing-owner") delete entry.data.ownerSessionFile;
        if (scenario.startsWith("foreign")) entry.data.ownerSessionId = "foreign-owner";
      }
      if (scenario === "copied-file") {
        const copy = join(dir, "copied-parent.jsonl");
        writeFileSync(copy, readFileSync(parent.ctx.sessionManager.getSessionFile()));
        parent.ctx.sessionManager.getSessionFile = () => copy;
      }
      const before = paneMutations(parent).length;
      if (scenario === "unrelated-tree") {
        const result = await launch(parent, { role: "fixer", cwd: other });
        assert.equal(result.details.cwd, realpathSync.native(other));
      } else {
        await assert.rejects(() => launch(parent, { role: "fixer", cwd: scenario === "same-tree" ? cwd : other }), /uncertain leaf launch/);
        assert.equal(paneMutations(parent).length, before);
      }
      // An external-only launch admits only beside verified unrelated tree identity; unknown scope stays global.
      if (["same-tree", "unrelated-tree"].includes(scenario)) {
        const result = await launch(parent, { role: "writer", externalOnly: true, cwd: external });
        assert.equal(result.details.cwd, external);
      } else {
        const mutations = paneMutations(parent).length;
        for (const params of [{ role: "writer" }, { role: "reviewer", reviewFamily: "anthropic" }]) {
          await assert.rejects(() => launch(parent, { ...params, externalOnly: true, cwd: external }), /uncertain leaf launch/);
        }
        assert.equal(paneMutations(parent).length, mutations);
      }
    });
  }
});

test("configuration and non-code leaves use native profiles and their venue without a code wrapper", async () => {
  const { cwd } = linked();
  const owner = fleetParent(cwd);
  herdrFleet(owner.pi);
  for (const [role, model, thinking] of [
    ["fixer", "claude-opus-5-5", "low"],
    ["writer", "claude-fable-5-1", "medium"],
    ["scout", "claude-sonnet-5-5", "medium"],
    ["context-builder", "claude-sonnet-5-5", "medium"],
    ["oracle", "gpt-6.1-sol", "high"],
    ["debugger", "gpt-6-astra", "high"],
  ]) {
    const result = await launch(owner, { role, cwd });
    const start = owner.pi.execCalls.findLast((call: string[]) => call[0] === "herdr" && call[2] === "start");
    assert.equal(start[start.indexOf("--model") + 1], `cloudflare-ai-gateway/${model}`);
    assert.equal(start[start.indexOf("--thinking") + 1], thinking);
    assert.equal(result.details.cwd, cwd);
    assert.equal(result.details.claimPath, undefined);
    const prompt = owner.pi.execCalls.findLast((call: string[]) => call[0] === "herdr" && call[2] === "prompt")[4];
    assert.match(prompt, new RegExp(`${role}: `));
    assert.match(prompt, /Do not|Read-only/);
    owner.roster.length = 1;
  }
  assert.equal(owner.pi.execCalls.some((call: string[]) => call.includes("add") && call.includes("worktree")), false);
});

test("original isolated fixer and writer owners request fresh review beside their settled author or after its closure", async () => {
  for (const [role, author] of [["fixer", "retained"], ["writer", "retained"], ["fixer", "closed"], ["writer", "closed"]]) {
    const { source, cwd } = linked();
    const parent = fleetParent(source);
    herdrFleet(parent.pi);
    const authored = await launch(parent, { role, cwd });
    // The parent verified command exits separately; native status and roster absence prove neither.
    if (author === "closed") parent.roster.length = 1;
    else parent.roster[1].agent_status = "idle";
    for (const review of ["reviewer", "reviewer-security"]) {
      const result = await launch(parent, { role: review, reviewFamily: "anthropic", cwd });
      assert.equal(result.details.cwd, realpathSync.native(cwd));
      assert.equal(result.details.parent, parent.ctx.sessionManager.getSessionId());
      assert.equal(result.details.claimPath, undefined);
      assert.equal(result.details.retainedAuthor, author === "retained" ? authored.details.childSessionId : undefined);
      parent.roster.length = author === "closed" ? 1 : 2;
    }
    if (author === "retained") {
      // A pane bound to the recorded file whose saved header names another session is not the retained author.
      writeFileSync(sessionFile(parent.roster[1]), JSON.stringify({ type: "session", id: "different-native-uuid", cwd: realpathSync.native(cwd) }) + "\n");
      const before = paneMutations(parent).length;
      await assert.rejects(() => launch(parent, { role: "reviewer", reviewFamily: "anthropic", cwd }), /Native child session header does not match this launch/);
      assert.equal(paneMutations(parent).length, before);
    }
    parent.pi.events.on("pi-change-working-dir:resolve-execution-cwd", (request: { result?: { cwd: string } }) => { request.result = { cwd }; });
    await assert.rejects(() => launch(parent, { role: "worker", cwd }), /same admitted task tree/);
  }
});

test("isolated review refuses unrelated or copied owners, live actors, uncertain starts and leaf recursion", async () => {
  for (const refusal of ["unrelated", "copied", "native-identity", "occupied", "uncertain", "leaf", "tree"]) {
    const { source, cwd } = linked();
    const parent = fleetParent(source);
    herdrFleet(parent.pi);
    await launch(parent, { role: "fixer", cwd });
    if (refusal !== "occupied") parent.roster.length = 1;
    let caller = parent;
    if (refusal === "unrelated") { caller = fleetParent(source, "unrelated-owner"); herdrFleet(caller.pi); }
    if (refusal === "copied") {
      const copy = join(cwd, "copied-session.jsonl");
      writeFileSync(copy, readFileSync(parent.ctx.sessionManager.getSessionFile()));
      parent.ctx.sessionManager.getSessionFile = () => copy;
    }
    if (refusal === "native-identity") parent.roster[0].agent_session = { kind: "id", value: "not-the-owner" };
    if (refusal === "uncertain") {
      const exec = parent.pi.execImpl;
      parent.pi.execImpl = (cmd: string, args: string[]) => cmd === "herdr" && args[1] === "start"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "agent_not_ready", killed: false }) : exec(cmd, args);
      await assert.rejects(() => launch(parent, { role: "fixer", cwd }), /agent_not_ready/);
    }
    if (refusal === "leaf") process.env.PAWPRINT_FLEET_LEAF = "1";
    // Give fallback managed admission the correct execution tree: ownership refusals
    // must not pass merely because the caller started from another directory.
    caller.pi.events.on("pi-change-working-dir:resolve-execution-cwd", (request: { result?: { cwd: string } }) => { request.result = { cwd }; });
    const expected: Record<string, RegExp> = {
      unrelated: /same admitted task tree/, copied: /same admitted task tree/,
      "native-identity": /native session-file identity/, occupied: /predecessor is still live/,
      uncertain: /uncertain leaf launch/, leaf: /leaf/i, tree: /same admitted task tree/,
    };
    const before = paneMutations(caller).length;
    try {
      await assert.rejects(() => launch(caller, { role: "reviewer", reviewFamily: "anthropic", cwd: refusal === "tree" ? linked().cwd : cwd }), expected[refusal]);
      assert.equal(paneMutations(caller).length, before);
    } finally { delete process.env.PAWPRINT_FLEET_LEAF; }
  }
});

test("the same settled author survives each fresh review and receives corrections without a second author", async () => {
  try {
    const { owner, cwd } = await deliveryOwner();
    herdrFleet(owner.pi);
    const author = await launch(owner, { name: "author", role: "worker", cwd });
    const native = owner.roster.at(-1);
    assert.ok(native);
    // A working author is editing: no review of a moving candidate.
    await assert.rejects(() => launch(owner, { name: "review", role: "reviewer", reviewFamily: "openai", cwd }), /Task tree occupied by author;/);
    for (const round of [1, 2]) {
      native.agent_status = round === 1 ? "idle" : "done";
      // A settled author admits only review: never a second author.
      for (const role of ["worker", "writer", "fixer"]) {
        const before = paneMutations(owner).length;
        await assert.rejects(() => launch(owner, { name: "extra", role, cwd }), /Task tree occupied by author;/);
        assert.equal(paneMutations(owner).length, before);
      }
      for (const role of ["reviewer", "reviewer-security"]) {
        const review = await launch(owner, { name: "review", role, reviewFamily: "openai", cwd });
        assert.equal(review.details.cwd, cwd);
        assert.equal(review.details.retainedAuthor, author.details.childSessionId);
        assert.match(review.content[0].text, /Retained author here: author .*command exits were not checked/);
        const before = paneMutations(owner).length;
        await assert.rejects(() => launch(owner, { name: "extra", role: "reviewer", reviewFamily: "openai", cwd }), /Task tree occupied by review;/);
        assert.equal(paneMutations(owner).length, before);
        owner.roster.splice(owner.roster.findIndex((agent) => agent.pane_id === review.details.paneId), 1);
      }
      // Owner returns the findings to the same native author session.
      native.agent_status = "working";
      await assert.rejects(() => launch(owner, { name: "review", role: "reviewer", reviewFamily: "openai", cwd }), /Task tree occupied by author;/);
    }
    assert.equal(owner.roster.at(-1), native);
    const authors = owner.pi.execCalls.filter((call: string[]) => call[0] === "herdr" && call[2] === "start" && call.includes("cloudflare-ai-gateway/claude-opus-5-5") && call.includes("high"));
    assert.equal(authors.length, 1, "corrections never launch a fresh author");
  } finally {
    process.env.HERDR_PANE_ID = "wT:p1";
  }
});

test("review beside a retained author refuses busy, unknown, mismatched, unowned or uncertain actors", async (t) => {
  for (const scenario of ["working", "blocked", "unknown", "missing-status", "session-mismatch", "moved-pane", "unowned-author", "unrelated-occupant", "uncertain-author", "two-authors", "header-uuid", "header-cwd", "header-missing"]) {
    await t.test(scenario, async () => {
      try {
        const { owner, cwd } = await deliveryOwner();
        herdrFleet(owner.pi);
        if (scenario === "uncertain-author") {
          const exec = owner.pi.execImpl;
          owner.pi.execImpl = (cmd: string, args: string[]) => cmd === "herdr" && args[1] === "prompt"
            ? Promise.resolve({ code: 1, stdout: "", stderr: "agent_prompt_stalled", killed: false }) : exec(cmd, args);
          await assert.rejects(() => launch(owner, { name: "author", role: "worker", cwd }), /agent_prompt_stalled/);
          owner.pi.execImpl = exec;
        } else await launch(owner, { name: "author", role: "worker", cwd });
        const native = owner.roster.at(-1);
        assert.ok(native);
        native.agent_status = "idle";
        if (["working", "blocked", "unknown"].includes(scenario)) native.agent_status = scenario;
        if (scenario === "missing-status") delete native.agent_status;
        if (scenario === "session-mismatch") native.agent_session = { kind: "id", value: "somebody-else" };
        if (scenario === "moved-pane") native.pane_id = "wN:p8";
        if (scenario === "unowned-author") for (const entry of owner.pi.state.entries) entry.data.ownerSessionId = "foreign-owner";
        if (scenario === "unrelated-occupant") owner.roster.push({ name: "stranger", pane_id: "wN:p9", cwd, agent_status: "idle" });
        if (scenario === "two-authors") {
          const record = owner.pi.state.entries.at(-1).data;
          owner.pi.appendEntry("fleet-launch", { ...record, launchId: "second-author", childSessionId: "second", paneId: "wN:p9", role: "writer" });
          owner.roster.push({ name: "second", pane_id: "wN:p9", cwd, agent_status: "idle", agent_session: { kind: "id", value: "second" } });
        }
        const { childSessionId } = owner.pi.state.entries.at(-1).data;
        if (scenario === "header-uuid") writeFileSync(sessionFile(native), JSON.stringify({ type: "session", id: "different-native-uuid", cwd }) + "\n");
        if (scenario === "header-cwd") writeFileSync(sessionFile(native), JSON.stringify({ type: "session", id: childSessionId, cwd: realpathSync.native(tmpdir()) }) + "\n");
        if (scenario === "header-missing") rmSync(sessionFile(native));
        const expected: Record<string, RegExp> = {
          "unrelated-occupant": /Task tree occupied by stranger;/, "uncertain-author": /uncertain leaf launch/,
          "two-authors": /predecessor is still live but not a settled retained author/,
          "header-uuid": /Native child session header does not match this launch/,
          "header-cwd": /Native child session header does not match this launch/,
          "header-missing": /Retained author's native session file is missing/,
        };
        const before = paneMutations(owner).length;
        for (const params of [{ role: "reviewer", reviewFamily: "anthropic" }, { role: "reviewer-security", reviewFamily: "openai" }]) {
          await assert.rejects(() => launch(owner, { name: "review", ...params, cwd }), expected[scenario] ?? /Task tree occupied by author;/);
        }
        assert.equal(paneMutations(owner).length, before);
      } finally {
        process.env.HERDR_PANE_ID = "wT:p1";
      }
    });
  }
});

const sessionFile = (agent: Record<string, unknown>) => (agent.agent_session as { value: string }).value;

// Scratch under this checkout is inside a Git worktree; an external venue must not be.
function externalDirectory() {
  const external = realpathSync.native(mkdtempSync(join(tmpdir(), "pawprint-external-")));
  after(() => rmSync(external, { recursive: true, force: true }));
  assert.throws(() => git(external, "rev-parse", "--is-inside-work-tree"));
  return external;
}

test("an explicit external-only writer uses an ordinary task directory, never a repository", async () => {
  const { source, cwd } = linked();
  const external = externalDirectory();
  const broken = mktmp("broken-gitfile");
  writeFileSync(join(broken, ".git"), `gitdir: ${join(broken, "missing")}\n`);
  mkdirSync(join(source, "nested"));
  const parent = fleetParent(source);
  herdrFleet(parent.pi);
  const result = await launch(parent, { name: "notes", role: "writer", externalOnly: true, cwd: external });
  assert.equal(result.details.cwd, external);
  assert.equal(result.details.externalOnly, true);
  assert.equal(result.details.worktreeKey, undefined);
  const tab = parent.pi.execCalls.find((call: string[]) => call[0] === "herdr" && call[1] === "tab");
  assert.equal(tab[tab.indexOf("--workspace") + 1], "wT");
  assert.ok(tab.includes("PAWPRINT_FLEET_LEAF=1"));
  const prompt = parent.pi.execCalls.findLast((call: string[]) => call[0] === "herdr" && call[2] === "prompt")[4];
  assert.match(prompt, /External-only.*never edit.*repository/i);
  assert.equal(parent.pi.execCalls.some((call: string[]) => call.includes("worktree")), false);
  // The same writer keeps the directory: no second author beside it.
  await assert.rejects(() => launch(parent, { name: "notes", role: "writer", externalOnly: true, cwd: external }), /Task directory occupied by notes;/);
  parent.roster.length = 1;
  const before = paneMutations(parent).length;
  for (const [params, expected] of [
    [{ role: "writer", externalOnly: true, cwd }, /External-only writers cannot use a Git repository/],
    [{ role: "writer", externalOnly: true, cwd: source }, /External-only writers cannot use a Git repository/],
    [{ role: "writer", externalOnly: true, cwd: join(source, "nested") }, /External-only writers cannot use a Git repository/],
    [{ role: "writer", externalOnly: true, cwd: broken }, /External-only writers cannot use a Git repository/],
    [{ role: "writer", cwd: external }, /git rev-parse/],
    [{ role: "fixer", externalOnly: true, cwd: external }, /externalOnly is only valid for writer, reviewer/],
    [{ role: "scout", externalOnly: true, cwd: external }, /externalOnly is only valid for writer, reviewer/],
  ] as const) {
    await assert.rejects(() => launch(parent, { name: "notes", ...params }), expected);
  }
  parent.roster.push({ name: "stranger", pane_id: "wU:p9", cwd: external });
  await assert.rejects(() => launch(parent, { name: "notes", role: "writer", externalOnly: true, cwd: external }), /Task directory occupied by stranger;/);
  parent.roster.length = 1;
  await parent.pi.commands.delegate.handler(`--role writer --external-only --cwd "${external}" notes ${task}`, parent.ctx);
  assert.equal(parent.ctx.notes.at(-1).level, "info");
  assert.equal(paneMutations(parent).length, before + 3);
});

test("fresh external review runs beside or after only the caller's own settled external-only writer", async () => {
  const external = externalDirectory();
  const { source } = fleetRepo();
  const parent = fleetParent(source);
  herdrFleet(parent.pi);
  const writer = await launch(parent, { name: "notes", role: "writer", externalOnly: true, cwd: external });
  const native = parent.roster.at(-1);
  assert.ok(native);
  const review = (params: Record<string, unknown> = {}) =>
    launch(parent, { name: "review", role: "reviewer", reviewFamily: "anthropic", externalOnly: true, cwd: external, ...params });
  // A working writer is still changing the candidate.
  await assert.rejects(() => review(), /Task directory occupied by notes;/);
  native.agent_status = "idle";
  for (const role of ["reviewer", "reviewer-security"]) {
    const result = await review({ role });
    assert.equal(result.details.retainedAuthor, writer.details.childSessionId);
    assert.match(result.content[0].text, /Retained author here: notes .*command exits were not checked/);
    const prompt = parent.pi.execCalls.findLast((call: string[]) => call[0] === "herdr" && call[2] === "prompt")[4];
    assert.match(prompt, /External-only review:.*Do not edit files or repositories and do not change external records/);
    assert.doesNotMatch(prompt, /External-only: change only/);
    const before = paneMutations(parent).length;
    await assert.rejects(() => review({ name: "extra" }), /Task directory occupied by review;/);
    await assert.rejects(() => launch(parent, { name: "extra", role: "writer", externalOnly: true, cwd: external }), /Task directory occupied by notes, review;/);
    assert.equal(paneMutations(parent).length, before);
    parent.roster.splice(parent.roster.findIndex((agent) => agent.pane_id === result.details.paneId), 1);
  }
  // The writer receives corrections in the same session, then settles for the next fresh review.
  native.agent_status = "working";
  await assert.rejects(() => review(), /Task directory occupied by notes;/);
  native.agent_status = "done";
  parent.roster.push({ name: "stranger", pane_id: "wU:p9", foreground_cwd: external });
  await assert.rejects(() => review(), /Task directory occupied by stranger;/);
  parent.roster.pop();
  const header = readFileSync(sessionFile(native), "utf8");
  writeFileSync(sessionFile(native), JSON.stringify({ type: "session", id: writer.details.childSessionId, cwd: realpathSync.native(tmpdir()) }) + "\n");
  await assert.rejects(() => review(), /Native child session header does not match this launch/);
  writeFileSync(sessionFile(native), header);
  native.agent_session = { kind: "id", value: "somebody-else" };
  await assert.rejects(() => review(), /Task directory occupied by notes;/);
  parent.roster.length = 1;
  const closed = await review();
  assert.equal(closed.details.retainedAuthor, undefined);
  parent.roster.length = 1;
  const other = externalDirectory();
  const unrelated = fleetParent(source, "unrelated-owner");
  herdrFleet(unrelated.pi);
  const before = paneMutations(parent).length + paneMutations(unrelated).length;
  for (const [caller, params, expected] of [
    [unrelated, {}, /needs this caller's own prompted external-only writer/],
    [parent, { cwd: other }, /needs this caller's own prompted external-only writer/],
    [parent, { cwd: source }, /cannot use a Git repository/],
    [parent, { externalOnly: undefined }, /git rev-parse/],
  ] as const) {
    await assert.rejects(() => launch(caller, { name: "review", role: "reviewer", reviewFamily: "anthropic", externalOnly: true, cwd: external, ...params }), expected);
  }
  parent.roster[0].agent_session = { kind: "id", value: "not-the-owner" };
  await assert.rejects(() => review(), /Native child session identity/);
  assert.equal(paneMutations(parent).length + paneMutations(unrelated).length, before);
});

test("an external-only launch keeps a vanished tree's uncertain or live author blocking at the same path", async () => {
  for (const scenario of ["uncertain", "live-elsewhere"]) {
    const { source, dir } = fleetRepo(join(externalDirectory(), "repo"));
    const cwd = join(dir, "linked");
    git(source, "worktree", "add", "-q", "-b", "linked", cwd);
    const parent = fleetParent(source);
    herdrFleet(parent.pi);
    if (scenario === "uncertain") {
      const exec = parent.pi.execImpl;
      parent.pi.execImpl = (cmd: string, args: string[]) => cmd === "herdr" && args[1] === "prompt"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "agent_prompt_stalled", killed: false }) : exec(cmd, args);
      await assert.rejects(() => launch(parent, { name: "author", role: "writer", cwd }), /agent_prompt_stalled/);
      parent.pi.execImpl = exec;
      parent.roster.length = 1;
    } else {
      await launch(parent, { name: "author", role: "writer", cwd });
      // Still bound to its recorded session, now reporting another directory.
      parent.roster[1].cwd = realpathSync.native(tmpdir());
    }
    rmSync(join(cwd, ".git"));
    const before = paneMutations(parent).length;
    await assert.rejects(() => launch(parent, { name: "external", role: "writer", externalOnly: true, cwd }),
      scenario === "uncertain" ? /uncertain leaf launch/ : /Another agent may still write to this task tree: author/, scenario);
    assert.equal(paneMutations(parent).length, before);
  }
});

// Decision cases supply Git identity at pi.exec; paths, sessions and admission locks stay real.
function identityLinked() {
  const dir = mktmp("fleet-identity");
  const source = join(dir, "source");
  const cwd = join(dir, "existing");
  const common = join(source, ".git");
  const key = join(common, "worktrees", "existing");
  for (const path of [source, cwd, key]) mkdirSync(path, { recursive: true });
  const parent = fleetParent(source);
  const exec = parent.pi.execImpl;
  const identities: Record<string, { root: string; key: string; branch: string }> = {
    [source]: { root: source, key: common, branch: "main" },
    [cwd]: { root: cwd, key, branch: "existing" },
  };
  parent.pi.execImpl = (cmd: string, args: string[]) => {
    if (cmd !== "git") return exec(cmd, args);
    const identity = identities[realpathSync.native(args[1])];
    assert.ok(identity, `unconfigured Git identity: ${args[1]}`);
    const outputs: Record<string, string> = {
      "rev-parse --is-inside-work-tree": "true",
      "rev-parse --show-toplevel": identity.root,
      "rev-parse --absolute-git-dir": identity.key,
      "rev-parse --path-format=absolute --git-common-dir": common,
      "branch --show-current": identity.branch,
      "rev-parse --verify HEAD^{commit}": "0123456789abcdef0123456789abcdef01234567",
    };
    const stdout = outputs[args.slice(2).join(" ")];
    assert.notEqual(stdout, undefined, `unconfigured Git response: ${args.join(" ")}`);
    return Promise.resolve({ code: 0, stdout, stderr: "", killed: false });
  };
  parent.workspaces.push({ workspace_id: "wT" }, {
    workspace_id: "wN",
    worktree: { checkout_path: cwd, repo_key: common, repo_root: source, repo_name: "source", is_linked_worktree: true },
  });
  return { dir, source, cwd, key, common, parent };
}

test("Delivery Lead uses the supplied native tree without a second worktree or persistent claim", async () => {
  const { source, cwd } = linked();
  const parent = managedParent(source, cwd);
  parent.roster.push({ name: "neighbor", pane_id: "wN:p9", workspace_id: "wN", cwd: source });
  herdrFleet(parent.pi);
  const result = await launch(parent, { role: "delivery-lead", cwd });
  assert.equal(result.details.role, "delivery-lead");
  const tab = parent.pi.execCalls.find((call: string[]) => call[0] === "herdr" && call[1] === "tab");
  assert.equal(tab[tab.indexOf("--workspace") + 1], "wN");
  assert.equal(result.details.paneId, "wN:p2");
  assert.equal(parent.roster.at(-1)?.workspace_id, "wN");
  assert.equal(parent.pi.execCalls.some((call: string[]) => call[1] === "workspace" && call[2] !== "list"), false);
  assert.equal(result.details.cwd, cwd);
  assert.equal(result.details.claimPath, undefined);
  const key = git(cwd, "rev-parse", "--absolute-git-dir");
  assert.equal(existsSync(join(key, "pawprint-writer.json")), false);
  assert.equal(existsSync(join(key, "pawprint-writer.lock")), false);
  assert.equal(parent.pi.execCalls.some((call: string[]) => call.includes("add") && call.includes("worktree")), false);
  const start = parent.pi.execCalls.find((call: string[]) => call[0] === "herdr" && call[2] === "start");
  assert.equal(start[start.indexOf("--model") + 1], "cloudflare-ai-gateway/gpt-6-astra");
  const contract = start[start.indexOf("--append-system-prompt") + 1];
  assert.equal(contract, new URL("../agent/configs/delivery-lead.md", import.meta.url).pathname);
  assert.match(readFileSync(contract, "utf8"), /^# Delivery Lead/);
  // Launchers loaded before the rename still read the managed-coder key until /reload.
  const profiles = JSON.parse(readFileSync(new URL("../agent/configs/session-roles.json", import.meta.url), "utf8"));
  assert.deepEqual(profiles["managed-coder"], profiles["delivery-lead"]);
  const prompt = parent.pi.execCalls.find((call: string[]) => call[0] === "herdr" && call[2] === "prompt")[4];
  assert.ok(prompt.startsWith(task));
  assert.match(prompt, /parent owns.*closure/i);
  assert.doesNotMatch(prompt, /herdr tab close/);
  await parent.pi.commands.fleet.handler("", parent.ctx);
  assert.match(parent.ctx.notes.at(-1).msg, /lead.*\[mine\]/);
  assert.match(parent.ctx.notes.at(-1).msg, /neighbor.*\[yours\]/);
  const predecessor = parent.roster.at(-1);
  assert.ok(predecessor);
  predecessor.cwd = source;
  const before = paneMutations(parent).length;
  const previous = `lead \\(session ${result.details.childSessionId}, pane wN:p2, last recorded prompted at \\d{4}-[^,]+, launch ${result.details.launchId}\\)`;
  await assert.rejects(() => launch(parent, { role: "delivery-lead", cwd }), new RegExp(`may still write to this task tree: ${previous} is live or uncertain`));
  assert.equal(paneMutations(parent).length, before);
  parent.roster.length = 1;
  // A record persisted before the rename and the legacy role input still identify the same delivery owner.
  for (const entry of parent.pi.state.entries) if (entry.data?.launchId === result.details.launchId) entry.data.role = "managed-coder";
  const replacement = await launch(parent, { role: "managed-coder", cwd });
  assert.equal(replacement.details.role, "delivery-lead");
  assert.notEqual(replacement.details.childSessionId, result.details.childSessionId);
  assert.equal(replacement.details.cwd, cwd);
  assert.match(replacement.content[0].text, new RegExp(`Previous Delivery Lead in this tree: ${previous}\\. Its command exits were not checked\\.`));
});

test("managed destination refuses missing, ambiguous or inconsistent native identity before pane mutation", async (t) => {
  for (const [refusal, expected] of [
    ["missing", /Expected exactly one native workspace/],
    ["ambiguous", /Expected exactly one native workspace/],
    ["repository", /Inconsistent native workspace repository\/linked identity/],
    ["linked", /Inconsistent native workspace repository\/linked identity/],
    ["missing-repository", /Inconsistent native workspace repository\/linked identity/],
    ["missing-id", /Missing or duplicate native workspace identity/],
    ["duplicate-id", /Missing or duplicate native workspace identity/],
    ["relative-checkout", /Invalid native workspace checkout_path/],
    ["relative-repository", /Inconsistent native workspace repository\/linked identity/],
    ["stale-checkout", /Cannot resolve native workspace/],
    ["stale-repository", /Cannot resolve native workspace/],
    ["stale-unrelated-checkout", /Cannot resolve native workspace/],
    ["wrong-checkout", /Expected exactly one native workspace/],
  ] as const) {
    await t.test(refusal, async () => {
      const { source, cwd, dir, key, parent } = identityLinked();
      const metadata = parent.workspaces[1].worktree as Record<string, unknown>;
      switch (refusal) {
        case "missing": parent.workspaces.length = 1; break;
        case "ambiguous": parent.workspaces.push({ ...parent.workspaces[1], workspace_id: "wOther" }); break;
        case "repository": metadata.repo_key = key; break;
        case "linked": metadata.is_linked_worktree = false; break;
        case "missing-repository": delete metadata.repo_key; break;
        case "missing-id": delete parent.workspaces[1].workspace_id; break;
        case "duplicate-id": parent.workspaces[1].workspace_id = "wT"; break;
        case "relative-checkout": metadata.checkout_path = "existing"; break;
        case "relative-repository": metadata.repo_key = ".git"; break;
        case "stale-checkout": metadata.checkout_path = join(dir, "gone"); break;
        case "stale-repository": metadata.repo_key = join(dir, "gone.git"); break;
        case "stale-unrelated-checkout": parent.workspaces.push({ workspace_id: "wStale", worktree: { ...metadata, checkout_path: join(dir, "gone") } }); break;
        case "wrong-checkout": metadata.checkout_path = source; break;
      }
      herdrFleet(parent.pi);
      await assert.rejects(() => launch(parent, { role: "delivery-lead", cwd }), (error: Error) => {
        assert.match(error.message, expected);
        if (refusal.startsWith("stale-")) {
          const field = refusal === "stale-repository" ? "repo_key" : "checkout_path";
          assert.ok(error.message.includes(`workspace ${refusal === "stale-unrelated-checkout" ? "wStale" : "wN"}`));
          assert.ok(error.message.includes(field));
          assert.ok(error.message.includes(join(dir, field === "repo_key" ? "gone.git" : "gone")));
          assert.match(error.message, /ENOENT/);
          assert.match(error.message, /herdr workspace list/);
        }
        return true;
      });
      assert.equal(paneMutations(parent).length, 0);
      assert.equal(parent.pi.state.entries.at(-1).data.phase, "failed-before-pane");
      assert.equal(existsSync(join(key, "pawprint-writer.json")), false);
      assert.equal(existsSync(join(key, "pawprint-writer.lock")), false);
    });
  }
});

test("managed destination canonicalizes checkout and repository aliases without changing requested cwd", async () => {
  const { source, cwd, dir } = linked();
  const alias = join(dir, "checkout-alias");
  const repoAlias = join(dir, "repo-alias");
  symlinkSync(cwd, alias);
  symlinkSync(join(source, ".git"), repoAlias);
  mkdirSync(join(cwd, "nested"));
  const parent = managedParent(source, alias);
  const metadata = parent.workspaces[1].worktree as Record<string, unknown>;
  metadata.repo_key = repoAlias;
  herdrFleet(parent.pi);
  const result = await launch(parent, { role: "delivery-lead", cwd: join(alias, "nested") });
  assert.equal(result.details.cwd, join(cwd, "nested"));
  assert.equal(result.details.paneId, "wN:p2");
});

test("managed destination fails closed on unreadable metadata and cancellation", async (t) => {
  for (const refusal of ["shape", "command", "cancel"]) {
    await t.test(refusal, async () => {
      const { cwd, parent } = identityLinked();
      const exec = parent.pi.execImpl;
      const controller = new AbortController();
      parent.pi.execImpl = async (cmd: string, args: string[]) => {
        if (cmd === "herdr" && args[0] === "workspace") {
          if (refusal === "cancel") controller.abort();
          return { code: refusal === "command" ? 1 : 0, stdout: refusal === "shape" ? '{"result":{}}' : JSON.stringify({ result: { workspaces: parent.workspaces } }), stderr: "workspace metadata unavailable", killed: false };
        }
        return exec(cmd, args);
      };
      herdrFleet(parent.pi);
      await assert.rejects(() => parent.pi.tools.launch_agent.execute("refusal", { name: "lead", task, role: "delivery-lead", cwd }, controller.signal, undefined, parent.ctx),
        refusal === "cancel" ? /abort/i : /workspace/);
      assert.equal(paneMutations(parent).length, 0);
      assert.equal(parent.pi.state.entries.at(-1).data.phase, "failed-before-pane");
    });
  }
});

test("legacy Coder and Coordinator keep parent placement without native workspace metadata", async () => {
  for (const role of ["coder", "coordinator"]) {
    const { cwd, parent } = identityLinked();
    parent.workspaces.length = 0;
    herdrFleet(parent.pi);
    const result = await launch(parent, { role, cwd });
    assert.equal(result.details.cwd, cwd);
    assert.equal(result.details.paneId, "wT:p2");
    assert.equal(parent.pi.execCalls.some((call: string[]) => call[1] === "workspace"), false);
    assert.equal(Boolean(result.details.claimPath), role === "coder");
  }
});

test("Delivery Lead readmits after a proved pre-pane occupancy or trust refusal", async () => {
  for (const refusal of ["occupancy", "trust"]) {
    const { cwd, parent } = identityLinked();
    herdrFleet(parent.pi);
    if (refusal === "occupancy") {
      parent.roster.push({ name: "neighbor", pane_id: "wU:p9", cwd });
    } else {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(join(cwd, ".pi/settings.json"), "{}");
    }
    await assert.rejects(() => launch(parent, { role: "delivery-lead", cwd }),
      refusal === "occupancy" ? /occupied by neighbor/ : /Project trust decision required/);
    assert.equal(parent.pi.state.entries.at(-1).data.phase, "failed-before-pane");
    assert.equal(paneMutations(parent).length, 0);
    parent.roster.length = 1;
    const result = await launch(parent, {
      role: "delivery-lead", cwd, ...(refusal === "trust" ? { noProjectResources: true } : {}),
    });
    assert.equal(result.details.cwd, cwd);
    assert.equal(parent.pi.execCalls.filter((call: string[]) => call[0] === "herdr" && call[1] === "tab").length, 1);
  }
});

test("an uncertain same-tree launch blocks every writer role for its caller, whatever role it had", async (t) => {
  // Non-code helpers and Coordinators record no Git-dir key; their recorded cwd still places them in the tree.
  for (const first of ["delivery-lead", "worker", "scout", "context-builder", "oracle", "debugger", "coordinator"]) {
    await t.test(first, async () => {
      const { source, cwd } = linked();
      const parent = managedParent(source, cwd, cwd);
      const exec = parent.pi.execImpl;
      parent.pi.execImpl = (cmd: string, args: string[]) => cmd === "herdr" && args[0] === "tab"
        ? Promise.resolve({ code: 0, stdout: '{"result":{}}', stderr: "", killed: false }) : exec(cmd, args);
      herdrFleet(parent.pi);
      await assert.rejects(() => launch(parent, { role: first, cwd }), /no pane_id/);
      assert.equal(parent.pi.state.entries.at(-1).data.phase, "uncertain");
      parent.pi.execImpl = exec;
      const before = paneMutations(parent).length;
      const admitted: string[] = [];
      for (const role of ["worker", "reviewer", "fixer", "delivery-lead", "coder"]) {
        await launch(parent, { role, cwd }).then(() => { admitted.push(role); parent.roster.length = 1; }, (error: Error) => assert.match(error.message,
          /may still write to this task tree: lead[\w-]* \(session [^,]+, pane unknown, last recorded uncertain at |An uncertain leaf launch requires inspection/));
      }
      assert.deepEqual(admitted, [], `admitted after uncertain ${first}`);
      assert.equal(paneMutations(parent).length, before);
      // After manual settlement, a fresh human-directed session is not bound by another caller's records.
      const fresh = managedParent(source, cwd, cwd);
      herdrFleet(fresh.pi);
      assert.equal((await launch(fresh, { role: "worker", cwd })).details.cwd, cwd);
    });
  }
});

test("managed admission requires an unclaimed linked cwd and preserves legacy claims", async () => {
  const { source, cwd } = linked();
  const parent = fleetParent(source);
  herdrFleet(parent.pi);
  for (const params of [{}, { cwd: source }, { cwd, base: "HEAD" }]) {
    await assert.rejects(() => launch(parent, { role: "delivery-lead", ...params }), /cwd|linked|base/i);
  }
  assert.equal(paneMutations(parent).length, 0);
  const legacy = await launch(parent, { cwd });
  const bytes = readFileSync(legacy.details.claimPath, "utf8");
  const other = fleetParent(source, "another-owner");
  herdrFleet(other.pi);
  await assert.rejects(() => launch(other, { role: "delivery-lead", cwd }), /already claimed/i);
  assert.equal(readFileSync(legacy.details.claimPath, "utf8"), bytes);
  assert.equal(paneMutations(other).length, 0);
});

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
    await assert.rejects(() => pi.tools.launch_agent.execute("bad", { name: "lead", task, base: "HEAD", ...params }, undefined, undefined, ctx), /base is only valid/);
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

// Missing promisor HEAD whose lazy fetch runs a local core.sshCommand stub that only writes a marker.
function promisorRepo() {
  const fixture = fleetRepo();
  const marker = join(fixture.dir, "ssh-command-ran");
  git(fixture.source, "config", "core.repositoryformatversion", "1");
  git(fixture.source, "config", "extensions.partialClone", "origin");
  git(fixture.source, "config", "remote.origin.url", "ssh://example.invalid/x");
  git(fixture.source, "config", "remote.origin.promisor", "true");
  git(fixture.source, "config", "core.sshCommand", `touch '${marker}'; false`);
  writeFileSync(join(fixture.source, ".git/refs/heads/main"), "0123456789abcdef0123456789abcdef01234567\n");
  return { ...fixture, marker };
}

async function withLazyFetch(run: () => Promise<void>) {
  const lazyFetch = process.env.GIT_NO_LAZY_FETCH;
  delete process.env.GIT_NO_LAZY_FETCH;
  try { await run(); } finally {
    if (lazyFetch === undefined) delete process.env.GIT_NO_LAZY_FETCH;
    else process.env.GIT_NO_LAZY_FETCH = lazyFetch;
  }
}

test("admission and pre-pane release do not trigger an unchosen promisor neighbor's SSH command", async () => {
  const { source, cwd } = linked();
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi/settings.json"), "{}");
  const neighbor = promisorRepo();
  const repo = neighbor.source;
  const marker = neighbor.marker;
  mkdirSync(join(repo, "nested"));
  const alias = join(neighbor.dir, "alias");
  symlinkSync(repo, alias);
  const parent = fleetParent(source);
  parent.roster.push({ name: "neighbor", pane_id: "wU:p9", workspace_id: "wU", cwd: repo, foreground_cwd: join(alias, "nested") });
  herdrFleet(parent.pi);
  await withLazyFetch(async () => {
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
  });
});

test("a code leaf from another session tree is refused without lazy-fetching that repository or creating a pane", async () => {
  const { cwd } = linked();
  const session = promisorRepo();
  const parent = fleetParent(session.source);
  parent.pi.events.on("pi-change-working-dir:resolve-execution-cwd", (request: { result?: { cwd: string } }) => { request.result = { cwd }; });
  herdrFleet(parent.pi);
  await withLazyFetch(async () => {
    await assert.rejects(() => launch(parent, { role: "worker", cwd }), /same admitted task tree/);
  });
  assert.equal(existsSync(session.marker), false, "refusal must not execute the session repository's SSH command");
  assert.equal(paneMutations(parent).length, 0);
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
  const source = mktmp("in-memory");
  const parent = fleetParent(source);
  writeFileSync(join(source, ".git"), `gitdir: ${join(source, "missing")}\n`);
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
