// Actual standalone client/broker and real helper CLIs. Adapted cases from pr-review/test/pr-note.test.mjs.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// `alias` is the caller's short symlink to `dir`; it keeps the broker socket under the Unix socket path limit.
const [dir, alias] = process.argv.slice(2), repo = resolve(import.meta.dirname, ".."), scripts = process.argv[4] || join(repo, "scripts");
const pkg = join(repo, "node_modules/pi-intercom"), require = createRequire(join(pkg, "package.json"));
const env = { PATH: join(dir, "bin") + ":" + dirname(process.execPath) + ":/usr/bin:/bin", HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), PI_CODING_AGENT_DIR: alias, PI_INTERCOM_HOME: pkg, GIT_CEILING_DIRECTORIES: repo };
for (const path of [env.HOME, env.TMPDIR, join(dir, "bin"), join(dir, "checkout/src"), join(env.HOME, ".local/state/pr-watch"), join(env.HOME, ".config/pr-review")]) mkdirSync(path, { recursive: true });
for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env);
writeFileSync(join(dir, "bin/gh"), '#!/bin/sh\n[ "$1 $2" = "pr view" ] || exit 91\nprintf \'%s\\n\' \'{"number":42,"url":"https://github.com/example/repo/pull/42"}\'\n', { mode: 0o755 });
writeFileSync(join(dir, "checkout/src/a.ts"), "one\ntwo\nthree\n");
const git = spawnSync("/usr/bin/git", ["init", "-q", join(dir, "checkout")], { env, encoding: "utf8" }); assert.equal(git.status, 0, git.stderr);
const { tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
const { IntercomClient } = await tsImport(pathToFileURL(join(pkg, "broker/client.ts")).href, import.meta.url);
const socket = join(alias, "intercom/broker.sock"); assert.ok(Buffer.byteLength(socket) <= 100);
const broker = spawn(process.execPath, ["--import", require.resolve("tsx/esm"), join(pkg, "broker/broker.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
const brokerOutput = []; broker.stdout.on("data", data => brokerOutput.push(String(data))); broker.stderr.on("data", data => brokerOutput.push(String(data)));
let brokerExit; broker.on("close", (code, signal) => { brokerExit = { code, signal }; });
const wait = async (condition, label) => { const end = Date.now() + 10000; while (!(await condition())) { if (Date.now() >= end) throw new Error("Timeout: " + label + brokerOutput.join("")); await delay(10); } };
const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
const ghost = "00000000-0000-4000-8000-000000000099";
const clients = [], received = [[], [], []], commands = [];
const run = (name, args, extra = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [join(scripts, name), ...args], { cwd: dir, env: { ...env, ...extra.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; }); child.on("error", reject);
  child.on("close", (code, signal) => { const result = { name, args, pid: child.pid, code, signal, stdout, stderr }; commands.push(result); resolveRun(result); });
  child.stdin.end(extra.input || "");
});
const json = result => { assert.equal(result.signal, null); return JSON.parse(result.stdout); };
const note = ["--pr", "example/repo#42", "--path", "src/a.ts", "--start", "1", "--body", "review note"];
let failure;
try {
  await wait(() => existsSync(socket) && existsSync(join(dir, "intercom/broker.pid")) && Number(readFileSync(join(dir, "intercom/broker.pid"))) === broker.pid, "broker socket and matching PID"); assert.equal(Number(readFileSync(join(dir, "intercom/broker.pid"))), broker.pid);
  for (let i = 0; i < ids.length; i++) {
    const client = new IntercomClient(); clients.push(client);
    client.on("message", (_from, message) => received[i].push(message));
    await client.connect({ name: i < 2 ? "duplicate" : ghost, cwd: i === 0 ? join(dir, "checkout") : dir, model: "none", pid: process.pid, startedAt: Math.trunc(performance.timeOrigin), lastActivity: Date.now() }, ids[i]);
  }
  let result = await run("pr-note", ["--list"]); assert.equal(result.code, 0, result.stderr); assert.ok(json(result).some(peer => peer.id === ids[0]));
  result = await run("pr-note", ["--resolve", ids[0]]); assert.equal(result.code, 0, result.stderr); assert.deepEqual(json(result), { id: ids[0], name: "duplicate" });
  for (const name of ["duplicate", "dupli", "Duplicate"]) { result = await run("pr-note", ["--resolve", name]); assert.equal(result.code, 1); assert.match(result.stderr, name === "duplicate" ? /several sessions/ : /no intercom session named/); }
  for (const to of ["duplicate", ids[0].slice(0, -2), ghost]) { result = await run("pr-steer", ["--to", to, "--body", "must not send"]); assert.equal(result.code, 1); assert.match(result.stderr, /no intercom session with id/); }
  result = await run("pr-note", ["--to", ghost, ...note]); assert.equal(result.code, 1); assert.match(result.stderr, /no intercom session with id/); assert.deepEqual(received.map(messages => messages.length), [0, 0, 0]);
  clients[2].updatePresence({ name: "renamed-recipient" });
  await wait(async () => (await clients[0].listSessions()).some(peer => peer.id === ids[2] && peer.name === "renamed-recipient"), "renamed peer");
  result = await run("pr-note", ["--resolve", "renamed-recipient"]); assert.equal(result.code, 0, result.stderr); assert.deepEqual(json(result), { id: ids[2], name: "renamed-recipient" });
  result = await run("pr-steer", ["--to", ids[0], "--body", "tracked PR update"]); assert.equal(result.code, 0, result.stderr); assert.equal(json(result).ok, true);
  await wait(() => received[0].length === 1, "steer received"); assert.equal(received[0][0].content.text, "tracked PR update");
  const code = Array.from({ length: 205 }, (_, i) => "line " + i).join("\n");
  result = await run("pr-note", ["--json"], { input: JSON.stringify({ to: ids[0], pr: "example/repo#42", path: "src/a.ts", start: 3, body: "note body", code }) });
  assert.equal(result.code, 0, result.stderr); assert.equal(json(result).delivered, true); await wait(() => received[0].length === 2, "note received");
  const message = received[0][1]; assert.match(message.content.text, /example\/repo#42.*L3-L207/); assert.match(message.content.text, /truncated \(5 more lines\)/); assert.equal(message.content.attachments[0].name, "pr-note.json"); assert.equal(JSON.parse(message.content.attachments[0].content).code, code);
  writeFileSync(join(env.HOME, ".local/state/pr-watch/track.json"), JSON.stringify({ tracked: { "example/repo#42": { agent_id: ids[0], agent_name: "renamed" } } }));
  writeFileSync(join(env.HOME, ".config/pr-review/config.json"), JSON.stringify({ coordinator: ids[2] }));
  for (const { args, env: extra, expected, by } of [
    { args: ["--to", ids[1], ...note], env: { PR_REVIEW_COORDINATOR: ids[2] }, expected: ids[1], by: "to" },
    { args: note, env: { PR_REVIEW_COORDINATOR: ids[1] }, expected: ids[0], by: "track" },
    { args: ["--pr", "example/repo#7", ...note.slice(2)], env: { PR_REVIEW_COORDINATOR: ids[1] }, expected: ids[1], by: "env" },
    { args: ["--pr", "example/repo#7", ...note.slice(2)], env: {}, expected: ids[2], by: "config" },
    { args: ["--pr", "example/repo#7", "--path", join(dir, "checkout/src/a.ts"), "--start", "1", "--body", "note"], env: { PR_REVIEW_COORDINATOR: ids[1] }, expected: ids[0], by: "cwd" },
  ]) { result = await run("pr-note", ["--dry-run", ...args], { env: extra }); assert.equal(result.code, 0, result.stderr); assert.equal(json(result).to, expected); assert.equal(json(result).resolvedBy, by); }
  result = await run("pr-note", ["--dry-run", "--here", "--to", ids[0], "--path", join(dir, "checkout/src/a.ts"), "--code", "three", "--body", "editor note"]); assert.equal(result.code, 0, result.stderr); assert.equal(json(result).start, 3); assert.equal(json(result).path, "src/a.ts");
  result = await run("pr-note", ["--json"], { input: "{" }); assert.equal(result.code, 1); assert.match(json(result).error, /invalid JSON/);
  result = await run("pr-steer", ["--to", ids[0]]); assert.equal(result.code, 1); assert.match(result.stderr, /missing --body/);
  assert.deepEqual(received.map(messages => messages.length), [2, 0, 0]);
} catch (error) { failure = error.stack; }
finally {
  const disconnects = await Promise.allSettled(clients.map(client => client.disconnect()));
  if (disconnects.some(result => result.status !== "fulfilled")) failure ||= "client disconnect failed";
  if (!brokerExit) broker.kill("SIGTERM"); await wait(() => brokerExit, "broker closed");
  assert.deepEqual(brokerExit, { code: 0, signal: null }); assert.equal(existsSync(socket), false); assert.equal(existsSync(join(dir, "intercom/broker.pid")), false);
}
if (!failure) {
  const result = await run("pr-steer", ["--to", ids[0], "--body", "broker unavailable"]); assert.equal(result.code, 1); assert.match(result.stderr, /could not connect/);
  const resolved = await run("pr-note", ["--resolve", ghost]); assert.equal(resolved.code, 0); assert.deepEqual(json(resolved), { id: ghost, name: null });
}
console.log(JSON.stringify({ driverPid: process.pid, brokerPid: broker.pid, brokerExit, socket, received: received.map(messages => messages.length), commands, failure }));
if (failure) process.exitCode = 1;
