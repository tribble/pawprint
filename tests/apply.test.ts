// apply.test.ts — `setup.sh --apply` onto an EXISTING plain live config:
// intentional (source) settings win per key; runtime-owned (changelog stamp,
// device/tracking ids) and unmanaged live values survive at any depth; files
// only pi writes (credentials, sessions, package clones) are never touched;
// a second apply is a byte-identical no-write. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, linkSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mktmp, piPackageDir } from "./fixture.ts";

const REPO = join(import.meta.dirname, "..");
const SRC = join(REPO, "agent");

// oxlint-disable-next-line typescript/no-explicit-any -- fixture assertions index parsed JSON without narrowing every level
type Json = Record<string, any>;
const srcSettings: Json = JSON.parse(readFileSync(join(SRC, "settings.json"), "utf8"));
const srcMcp: Json = JSON.parse(readFileSync(join(SRC, "mcp.json"), "utf8"));

// setup.sh wires core.hooksPath into the checkout it runs from; GIT_DIR sends
// that write to a scratch repo so tests never touch this checkout's .git/config.
const GIT_DIR = mktmp("gitdir");
execFileSync("git", ["init", "-q", "--bare", GIT_DIR]);

function runApply(target: string) {
  return execFileSync("bash", [join(REPO, "setup.sh"), "--apply", "--target", target], {
    encoding: "utf8",
    env: { ...process.env, GIT_DIR },
  });
}

test("apply: managed values win, runtime/unmanaged survive, sentinels intact, second apply is a no-write", () => {
  const live = join(mktmp("apply"), "agent");
  mkdirSync(join(live, "sessions"), { recursive: true });
  mkdirSync(join(live, "git", "github.com", "acme", "some-pkg"), { recursive: true });

  // A live config pi has been running against: newer runtime stamp, device id,
  // conflicting managed values, live-only prefs at top level and nested inside
  // managed objects, a live-only packages list.
  writeFileSync(
    join(live, "settings.json"),
    JSON.stringify({
      defaultModel: "live/some-other-model",
      lastChangelogVersion: "999.0.0", // newer than source's — pi wrote it
      deviceId: "synthetic-device-123",
      editorPaddingX: 9, // live-only preference
      retry: { enabled: false, maxRetries: 1, provider: { timeoutMs: 1, liveOnlyMs: 7 } },
      compaction: { enabled: false, liveOnlyNested: { x: 1 } },
      subagents: { agentOverrides: { worker: { model: "live/model", liveOnlyFlag: true } } },
      packages: ["git:github.com/live/unrelated"],
    }),
  );
  // A live mcp.json: live-only server, live-only toggle on a managed server,
  // live-only top-level key, one conflicting managed value.
  writeFileSync(
    join(live, "mcp.json"),
    JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: {
        "slack-workos": { url: "https://wrong.example/mcp", enabled: false },
        "local-only": { command: "fake-server", args: ["--x"] },
      },
    }),
  );
  // Sentinels: synthetic stand-ins for files only pi/the machine writes.
  const auth = JSON.stringify({ synthetic: "NOT-A-REAL-CREDENTIAL" });
  const mcpAuth = JSON.stringify({ synthetic: "NOT-A-REAL-OAUTH-BLOB" });
  const session = JSON.stringify({ type: "synthetic-session" }) + "\n";
  const pkgFile = "synthetic installed package clone\n";
  writeFileSync(join(live, "auth.json"), auth);
  writeFileSync(join(live, "mcp-auth.json"), mcpAuth);
  writeFileSync(join(live, "sessions", "synthetic.jsonl"), session);
  writeFileSync(join(live, "git", "github.com", "acme", "some-pkg", "clone.txt"), pkgFile);
  // A source-only file the live dir drifted from: plain copy restores it.
  writeFileSync(join(live, "AGENTS.md"), "live drift\n");

  const out = runApply(live);
  assert.match(out, /applied: .*settings\.json/);
  assert.match(out, /applied: .*mcp\.json/);
  assert.ok(out.includes("machine machinery: SKIPPED"), "apply never runs machinery");

  const settings: Json = JSON.parse(readFileSync(join(live, "settings.json"), "utf8"));
  // managed values win, including package sources WITH their object-form filters
  assert.equal(settings.defaultModel, srcSettings.defaultModel);
  assert.equal(settings.retry.enabled, srcSettings.retry.enabled);
  assert.equal(settings.retry.maxRetries, srcSettings.retry.maxRetries);
  assert.equal(settings.retry.provider.timeoutMs, srcSettings.retry.provider.timeoutMs);
  assert.equal(settings.compaction.enabled, srcSettings.compaction.enabled);
  assert.equal(settings.subagents.agentOverrides.worker.model, srcSettings.subagents.agentOverrides.worker.model);
  assert.deepEqual(settings.packages, srcSettings.packages);
  assert.ok(
    settings.packages.some((p: Json) => typeof p === "object" && Array.isArray(p.extensions)),
    "package entry with extension/prompt/theme filters survived the write",
  );
  assert.deepEqual(settings.enabledModels, srcSettings.enabledModels);
  // runtime bookkeeping and unmanaged live values survive, at any depth
  assert.equal(settings.lastChangelogVersion, "999.0.0", "runtime stamp not source-managed");
  assert.equal(settings.deviceId, "synthetic-device-123");
  assert.equal(settings.editorPaddingX, 9);
  assert.equal(settings.retry.provider.liveOnlyMs, 7);
  assert.deepEqual(settings.compaction.liveOnlyNested, { x: 1 });
  assert.equal(settings.subagents.agentOverrides.worker.liveOnlyFlag, true);

  const mcp: Json = JSON.parse(readFileSync(join(live, "mcp.json"), "utf8"));
  // managed server: source fields win, live-only toggle on it survives
  assert.deepEqual(mcp.mcpServers["slack-workos"], { ...srcMcp.mcpServers["slack-workos"], enabled: false });
  // live-only server and live-only top-level key survive
  assert.deepEqual(mcp.mcpServers["local-only"], { command: "fake-server", args: ["--x"] });
  assert.equal(mcp.autoEnableCodemode, false);

  // sentinels byte-identical
  assert.equal(readFileSync(join(live, "auth.json"), "utf8"), auth);
  assert.equal(readFileSync(join(live, "mcp-auth.json"), "utf8"), mcpAuth);
  assert.equal(readFileSync(join(live, "sessions", "synthetic.jsonl"), "utf8"), session);
  assert.equal(readFileSync(join(live, "git", "github.com", "acme", "some-pkg", "clone.txt"), "utf8"), pkgFile);

  // source-only file overwritten with the source bytes; apply never snapshots
  // live files (no backups of anything under the live config dir, ever)
  assert.equal(readFileSync(join(live, "AGENTS.md"), "utf8"), readFileSync(join(SRC, "AGENTS.md"), "utf8"));
  assert.ok(!readdirSync(live).some((f) => f.includes(".bak-pawprint-")), "no backup of a live file");

  // second apply: no write. Epoch mtimes prove the files were not rewritten.
  const settingsPath = join(live, "settings.json");
  const mcpPath = join(live, "mcp.json");
  const settingsBytes = readFileSync(settingsPath);
  const mcpBytes = readFileSync(mcpPath);
  utimesSync(settingsPath, new Date(0), new Date(0));
  utimesSync(mcpPath, new Date(0), new Date(0));
  const out2 = runApply(live);
  assert.deepEqual(readFileSync(settingsPath), settingsBytes);
  assert.deepEqual(readFileSync(mcpPath), mcpBytes);
  assert.equal(statSync(settingsPath).mtimeMs, 0, "settings.json not rewritten");
  assert.equal(statSync(mcpPath).mtimeMs, 0, "mcp.json not rewritten");
  assert.match(out2, /unchanged: .*settings\.json/);
  assert.match(out2, /unchanged: .*mcp\.json/);
});

// --- review-fix regressions: direct apply-config.ts invocation --------------
const SCRIPT = join(REPO, "scripts", "apply-config.ts");
const SETTINGS = join(SRC, "settings.json");
const MCP = join(SRC, "mcp.json");
const runDirect = (args: string[]) =>
  spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, PAWPRINT_PI_PKG: piPackageDir() } });

test("unsafe target shapes are refused before any read or write", () => {
  const live = join(mktmp("guard"), "agent");
  mkdirSync(live, { recursive: true });

  // hardlinked target (nlink > 1): writing it would clobber the linked file
  const sentinel = join(live, "elsewhere.txt");
  writeFileSync(sentinel, "sentinel\n");
  linkSync(sentinel, join(live, "settings.json"));
  let r = runDirect(["settings", SETTINGS, join(live, "settings.json")]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /hardlinked/);
  assert.equal(readFileSync(sentinel, "utf8"), "sentinel\n", "linked file untouched");
  spawnSync("rm", [join(live, "settings.json")]);

  // symlinked PARENT component: writes would land outside the live dir
  const realDir = join(live, "real");
  mkdirSync(realDir);
  writeFileSync(join(realDir, "settings.json"), "{}\n");
  symlinkSync(realDir, join(live, "link"));
  r = runDirect(["settings", SETTINGS, join(live, "link", "settings.json")]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /symlinked path component/);
  assert.equal(readFileSync(join(realDir, "settings.json"), "utf8"), "{}\n", "link target untouched");

  // non-regular destination: a directory where the managed file belongs
  const dirDst = join(live, "mcp.json");
  mkdirSync(dirDst);
  r = runDirect(["mcp", MCP, dirDst]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /not a regular file/);
  assert.deepEqual(readdirSync(dirDst), [], "nothing written into the directory");
});

test("a '..' component or empty source/target is refused at the door — symlink+hardlink sentinel untouched", () => {
  // root/lnk -> outside/inner: 'root/lnk/../agent/mcp.json' resolves LEXICALLY
  // to root/agent/mcp.json but PHYSICALLY reaches outside/agent/mcp.json. The
  // pre-fix guard checked the lexical path while the write took the physical
  // one — so '..' is now refused outright, never resolved for the caller.
  const root = mktmp("dotdot");
  mkdirSync(join(root, "agent"), { recursive: true });
  const outside = join(root, "outside");
  mkdirSync(join(outside, "inner"), { recursive: true });
  mkdirSync(join(outside, "agent"), { recursive: true });
  symlinkSync(join(outside, "inner"), join(root, "lnk"));
  const sentinel = join(root, "sentinel.txt");
  writeFileSync(sentinel, "sentinel\n");
  linkSync(sentinel, join(outside, "agent", "mcp.json")); // the physical destination, hardlinked

  // string concatenation, not path.join: join() would collapse the '..' away
  const r = runDirect(["mcp", MCP, `${root}/lnk/../agent/mcp.json`]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /'\.\.'.*without \.\./);
  assert.equal(readFileSync(sentinel, "utf8"), "sentinel\n", "linked sentinel untouched");
  assert.equal(readFileSync(join(outside, "agent", "mcp.json"), "utf8"), "sentinel\n", "physical destination untouched");
  assert.ok(!existsSync(join(root, "agent", "mcp.json")), "nothing written at the lexical path either");

  // source side: a '..' source path refuses before any read or write
  const dst = join(root, "agent", "settings.json");
  const r2 = runDirect(["settings", `${SRC}/../agent/settings.json`, dst]);
  assert.notEqual(r2.status, 0, r2.stdout);
  assert.match(r2.stderr, /'\.\.'.*without \.\./);
  assert.ok(!existsSync(dst), "nothing written");

  // empty source/target refuse (usage), never resolve to the caller's cwd
  assert.equal(runDirect(["settings", SETTINGS, ""]).status, 2);
  assert.equal(runDirect(["settings", "", dst]).status, 2);
});

test("malformed managed boundaries are refused without discarding live data", () => {
  const live = mktmp("boundary");
  const dst = join(live, "mcp.json");

  // live mcpServers is an array (pi's own MCP writer refuses this shape too)
  const arrayLive = JSON.stringify({ mcpServers: [{ name: "slack" }] });
  writeFileSync(dst, arrayLive);
  let r = runDirect(["mcp", MCP, dst]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /mcpServers is not an object/);
  assert.equal(readFileSync(dst, "utf8"), arrayLive, "live bytes kept");

  // live nested server entry is not an object
  const badEntry = JSON.stringify({ mcpServers: { "slack-workos": ["broken"] } });
  writeFileSync(dst, badEntry);
  r = runDirect(["mcp", MCP, dst]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /mcpServers\.slack-workos/);
  assert.equal(readFileSync(dst, "utf8"), badEntry);

  // source-side malformed boundary (nothing live to discard, still refused)
  const badSrc = join(live, "bad-mcp.json");
  writeFileSync(badSrc, JSON.stringify({ mcpServers: [1] }));
  writeFileSync(dst, "{}\n");
  r = runDirect(["mcp", badSrc, dst]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /mcpServers is not an object/);
  assert.equal(readFileSync(dst, "utf8"), "{}\n");

  // settings: object-boundary mismatches refuse in both directions
  const sdst = join(live, "settings.json");
  const scalarSrc = join(live, "scalar-settings.json");
  writeFileSync(scalarSrc, JSON.stringify({ retry: false }));
  const liveObj = JSON.stringify({ retry: { pollEveryMs: 1 } });
  writeFileSync(sdst, liveObj);
  r = runDirect(["settings", scalarSrc, sdst]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /retry/);
  assert.equal(readFileSync(sdst, "utf8"), liveObj);

  const liveScalar = JSON.stringify({ retry: 5 });
  writeFileSync(sdst, liveScalar);
  r = runDirect(["settings", SETTINGS, sdst]);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /retry/);
  assert.equal(readFileSync(sdst, "utf8"), liveScalar);
});

test("failures are concise one-liners, not uncaught Node stacks", () => {
  const live = mktmp("concise");
  const dst = join(live, "settings.json");
  writeFileSync(dst, "{broken");
  const r = runDirect(["settings", SETTINGS, dst]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^apply-config: /);
  assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
  assert.equal(readFileSync(dst, "utf8"), "{broken");
});

test("--check never creates directories or files (validate must be side-effect free)", () => {
  const live = mktmp("checkmkdir");
  const missing = join(live, "nope");
  const r = runDirect(["--check", "settings", SETTINGS, join(missing, "settings.json")]);
  assert.equal(r.status, 1, "missing target is drift");
  assert.match(r.stdout, /drift: /);
  assert.ok(!existsSync(missing), "no directory created by a check");
});

test("--resolve-pi prints the resolved package; missing runtime or missing required export refuses clearly", () => {
  const ok = spawnSync("node", [SCRIPT, "--resolve-pi"], {
    encoding: "utf8",
    env: { ...process.env, PAWPRINT_PI_PKG: piPackageDir() },
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), piPackageDir());

  const live = mktmp("resolvepi");
  const bogus = spawnSync("node", [SCRIPT, "--resolve-pi"], {
    encoding: "utf8",
    env: { ...process.env, PAWPRINT_PI_PKG: join(live, "no-such-pkg") },
  });
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr, /^apply-config: /);

  // the modules exist but a required export does not: a refusal, never a skip
  const fake = join(live, "fake-pkg");
  mkdirSync(join(fake, "dist", "core"), { recursive: true });
  writeFileSync(join(fake, "dist", "core", "settings-manager.js"), "export {};\n");
  writeFileSync(join(fake, "dist", "core", "mcp-servers.js"), "export function validateMcpServerConfig() { return undefined; }\n");
  const noExport = spawnSync("node", [SCRIPT, "--resolve-pi"], {
    encoding: "utf8",
    env: { ...process.env, PAWPRINT_PI_PKG: fake },
  });
  assert.notEqual(noExport.status, 0);
  assert.match(noExport.stderr, /FileSettingsStorage/);
});

test("mcp: a merged managed server pi rejects is refused — apply and --check, bytes preserved, unmanaged fields kept", async () => {
  const { validateMcpServerConfig } = (await import(
    pathToFileURL(join(piPackageDir(), "dist", "core", "mcp-servers.js")).href
  )) as { validateMcpServerConfig: (name: string, config: unknown) => unknown };
  const live = mktmp("mcpconflict");
  const src = join(live, "src-mcp.json");
  const dst = join(live, "mcp.json");
  // Synthetic source + live, each valid on its own per pi's native validator,
  // conflicting only once merged (source callbackUrl port ≠ live callbackPort).
  const source = {
    mcpServers: {
      "slack-workos": {
        url: "https://mcp.slack.com/mcp",
        oauth: { clientId: "synthetic-client", callbackUrl: "http://localhost:3118/callback" },
      },
    },
  };
  const original = `${JSON.stringify(
    { mcpServers: { "slack-workos": { url: "https://mcp.slack.com/mcp", oauth: { callbackPort: 4000 } } } },
    null,
    2,
  )}\n`;
  assert.equal(typeof validateMcpServerConfig("slack-workos", source.mcpServers["slack-workos"]), "object", "source valid alone");
  assert.equal(
    typeof validateMcpServerConfig("slack-workos", JSON.parse(original).mcpServers["slack-workos"]),
    "object",
    "live valid alone",
  );
  writeFileSync(src, JSON.stringify(source));
  writeFileSync(dst, original);

  for (const args of [["mcp", src, dst], ["--check", "mcp", src, dst]]) {
    const r = runDirect(args);
    assert.notEqual(r.status, 0, `${args[0]} must refuse a merged config pi rejects`);
    assert.match(r.stderr, /slack-workos/);
    assert.match(r.stderr, /oauth\.callbackUrl and oauth\.callbackPort/);
    assert.match(r.stderr, /reapply/);
    assert.doesNotMatch(r.stderr.replaceAll(dst, ""), /4000|3118|synthetic-client/, "no field values leaked");
    assert.equal(readFileSync(dst, "utf8"), original, "live bytes preserved");
  }

  // a missing native validator fails clearly, never silently skips
  const bogus = spawnSync("node", [SCRIPT, "mcp", src, dst], {
    encoding: "utf8",
    env: { ...process.env, PAWPRINT_PI_PKG: join(live, "no-such-pkg") },
  });
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr, /mcp-servers\.js/);
  assert.equal(readFileSync(dst, "utf8"), original, "live bytes preserved");

  // compatible live port: apply succeeds and the unmanaged live callbackPort survives
  writeFileSync(
    dst,
    `${JSON.stringify({ mcpServers: { "slack-workos": { url: "https://mcp.slack.com/mcp", oauth: { callbackPort: 3118 } } } })}\n`,
  );
  const ok = runDirect(["mcp", src, dst]);
  assert.equal(ok.status, 0, ok.stderr);
  const merged = JSON.parse(readFileSync(dst, "utf8"));
  assert.equal(merged.mcpServers["slack-workos"].oauth.callbackPort, 3118, "unmanaged live field kept");
  assert.equal(merged.mcpServers["slack-workos"].oauth.callbackUrl, "http://localhost:3118/callback");
});
