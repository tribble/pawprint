// herdr-agent-state.ts: env-gated; when enabled, reports session + state
// machine (working/blocked/idle) to the herdr socket. Tests use a REAL unix
// socket server in a scratch dir — the extension's net code is the behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePi, makeCtx, eventually } from "./harness.mjs";

let seq = 0;
async function freshExtension() {
  // module reads process.env at load — query-bust the cache per test
  const mod = await import(`../pi-agent/extensions/herdr-agent-state.ts?case=${seq++}`);
  return mod.default;
}

function startServer(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "pawprint-herdr-"));
  const sock = join(dir, "h.sock");
  const received: any[] = [];
  const conns = new Set<net.Socket>();
  const server = net.createServer((c) => {
    conns.add(c);
    c.on("close", () => conns.delete(c));
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) received.push(JSON.parse(line));
      c.write("ok"); // any bytes finish the client's request
    });
  });
  t.after(() => {
    for (const c of conns) c.destroy();
    server.close();
  });
  return { sock, received, listen: () => new Promise<void>((r) => server.listen(sock, r)) };
}

test("disabled without herdr env: registers nothing", async () => {
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
  const ext = await freshExtension();
  const pi = makePi();
  ext(pi);
  assert.equal(pi.registered("session_start"), 0);
  assert.equal(pi.events.count("herdr:blocked"), 0);
});

test("enabled: tui session reports session + state machine over the socket", async (t) => {
  const srv = startServer(t);
  await srv.listen();
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = srv.sock;
  process.env.HERDR_PANE_ID = "pane-7";
  try {
    const ext = await freshExtension();
    const pi = makePi();
    ext(pi);
    assert.equal(pi.registered("session_start"), 1);
    assert.equal(pi.events.count("herdr:blocked"), 1);

    const ctx = makeCtx({ sessionFile: "/tmp/sess.jsonl", idle: true });
    await pi.emit("session_start", { reason: "launch" }, ctx);
    assert.ok(
      await eventually(() =>
        srv.received.some((m) => m.method === "pane.report_agent_session"),
      ),
      "session reported",
    );
    assert.ok(
      await eventually(() =>
        srv.received.some((m) => m.method === "pane.report_agent" && m.params.state === "idle"),
      ),
      "idle state reported (ctx.isIdle true)",
    );

    // blocked via custom event
    await pi.events.emit("herdr:blocked", { active: true, label: "waiting on tests" });
    assert.ok(
      await eventually(() =>
        srv.received.some(
          (m) => m.method === "pane.report_agent" && m.params.state === "blocked" && m.params.message === "waiting on tests",
        ),
      ),
      "blocked state reported",
    );

    // unblock + agent activity → working → settle → idle
    await pi.events.emit("herdr:blocked", { active: false });
    await pi.emit("agent_start", {}, ctx);
    assert.ok(
      await eventually(() =>
        srv.received.some((m) => m.method === "pane.report_agent" && m.params.state === "working"),
      ),
      "working state reported",
    );
    await pi.emit("agent_settled", {}, ctx);
    assert.ok(
      await eventually(() => {
        const states = srv.received.filter((m) => m.method === "pane.report_agent").map((m) => m.params.state);
        return states.at(-1) === "idle";
      }),
      "settled back to idle",
    );

    const session = srv.received.find((m) => m.method === "pane.report_agent_session");
    assert.equal(session.params.pane_id, "pane-7");
    assert.equal(session.params.agent_session_path, "/tmp/sess.jsonl");
  } finally {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
  }
});

test("enabled but non-tui mode: session_start is ignored", async (t) => {
  const srv = startServer(t);
  await srv.listen();
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = srv.sock;
  process.env.HERDR_PANE_ID = "pane-8";
  try {
    const ext = await freshExtension();
    const pi = makePi();
    ext(pi);
    const ctx = makeCtx({ sessionFile: "/tmp/s.jsonl" });
    ctx.mode = "rpc";
    await pi.emit("session_start", { reason: "launch" }, ctx);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(srv.received.length, 0, "headless modes report nothing");
  } finally {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
  }
});
