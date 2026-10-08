// imprint.test.ts — setup.sh, encoded. `--all` APPLIES the print onto a plain
// live dir (never a git worktree): source-only files copy, settings.json and
// mcp.json merge field-aware so runtime-owned and unmanaged live values
// survive. `--only` copies manifest paths for adopters (with backups); its
// settings.json/mcp.json get the same field-aware merge. Path entrypoints
// refuse any '..' component, a newline, or an empty target outright, never
// glob wildcard characters, and never resolve a symlinked path for the
// caller. Every run
// uses a throwaway fixture repo (tests/fixture.ts): nothing here touches this
// checkout's git or ~/.pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync, writeFileSync, readFileSync, existsSync,
  rmSync, chmodSync, readdirSync, lstatSync, readlinkSync, realpathSync, symlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { fixtureRepo, git, mktmp, piPackageDir, setupAll } from "./fixture.ts";

const REPO = join(import.meta.dirname, "..");
const PRINT = join(REPO, "agent");

const printFiles: string[] = JSON.parse(readFileSync(join(REPO, "manifest.json"), "utf8")).files;

// setup.sh wires core.hooksPath into the checkout it runs from; GIT_DIR sends
// that write to a scratch repo so tests never touch this checkout's .git/config.
const GIT_DIR = mktmp("gitdir");
execFileSync("git", ["init", "-q", "--bare", GIT_DIR]);
const SETUP_ENV = { ...process.env, GIT_DIR };
function runSetup(args: string[]) {
  return execFileSync("bash", [join(REPO, "setup.sh"), ...args], { encoding: "utf8", env: SETUP_ENV });
}
function spawnSetup(args: string[]) {  // for asserting on exit status + stderr
  return spawnSync("bash", [join(REPO, "setup.sh"), ...args], { encoding: "utf8", env: SETUP_ENV });
}
function manifest(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isSymbolicLink()) out.set(relative(dir, p), "link:" + readlinkSync(p));
      else out.set(relative(dir, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}
function manifestDiff(a: Map<string, string>, b: Map<string, string>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}

test("1. fresh target: plain live dir with every manifest file applied, no git anywhere, machinery never invoked", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("w1"), "pi");
  // PATH shim: any machinery invocation of these tools leaves a trace file
  const bin = mktmp("w1bin");
  const trace = join(bin, "TRACE");
  for (const tool of ["pi", "npm", "mise", "gh", "agent-browser"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> "${trace}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const r = setupAll(repo, live, [], { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of printFiles) assert.ok(existsSync(join(live, "agent", f)), `applied: ${f}`);
  // the merged files carry the source's managed values
  assert.deepEqual(JSON.parse(readFileSync(join(live, "agent", "settings.json"), "utf8")), JSON.parse(readFileSync(join(PRINT, "settings.json"), "utf8")));
  assert.deepEqual(JSON.parse(readFileSync(join(live, "agent", "mcp.json"), "utf8")), JSON.parse(readFileSync(join(PRINT, "mcp.json"), "utf8")));
  assert.ok(!existsSync(join(live, ".git")), "plain dir: no git linkage");
  assert.ok(!existsSync(join(live, "agent", "auth.json")), "no runtime files are created");
  assert.match(r.stdout, /^applied: .*settings\.json$/m);
  assert.match(r.stdout, /Manual steps remain: \/login/);
  assert.ok(r.stdout.includes("machine machinery: SKIPPED"));
  assert.ok(!existsSync(trace), "no machinery tool was invoked");
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main", "the source checkout is never touched");
});

test("2. existing live with runtime state: applied around it, no backups, sentinels byte-identical; repeated run writes nothing", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("w2"), "pi");
  mkdirSync(join(live, "agent", "sessions"), { recursive: true });
  const auth = JSON.stringify({ junk: "SECRET-DECOY" });
  writeFileSync(join(live, "agent", "auth.json"), auth);
  writeFileSync(join(live, "agent", "sessions", "x.jsonl"), "{}");
  mkdirSync(join(live, "agent", "git", "x"), { recursive: true });
  writeFileSync(join(live, "agent", "git", "x", "y"), "clone");
  mkdirSync(join(live, "agent", "bin"));
  writeFileSync(join(live, "agent", "bin", "fd"), "\xcf\xfa\xed\xfe not-a-real-binary");   // pi's managed binaries live here
  const srcSettings = JSON.parse(readFileSync(join(PRINT, "settings.json"), "utf8"));
  writeFileSync(join(live, "agent", "settings.json"), JSON.stringify({
    ...srcSettings,
    defaultModel: "live/other-model",       // managed: source wins
    lastChangelogVersion: "999.0.0",        // runtime: survives
    editorPaddingX: 9,                      // live-only: survives
  }));
  writeFileSync(join(live, "agent", "AGENTS.md"), "live drift\n"); // source-only: overwritten, no backup
  const r = setupAll(repo, live);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(join(live, "agent", "auth.json"), "utf8"), auth);
  const settings = JSON.parse(readFileSync(join(live, "agent", "settings.json"), "utf8"));
  assert.equal(settings.defaultModel, srcSettings.defaultModel);
  assert.equal(settings.lastChangelogVersion, "999.0.0");
  assert.equal(settings.editorPaddingX, 9);
  assert.equal(readFileSync(join(live, "agent", "AGENTS.md"), "utf8"), readFileSync(join(PRINT, "AGENTS.md"), "utf8"));
  assert.ok(!readdirSync(join(live, "agent")).some((f) => f.includes(".bak-pawprint-")), "apply makes no backups of live files");

  const before = manifest(live);
  const again = setupAll(repo, live);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.ok(!again.stdout.includes("imprinted:") && !again.stdout.includes("applied:"), "second run is a no-write");
  assert.match(again.stdout, /^unchanged: .*settings\.json$/m);
  assert.deepEqual(manifestDiff(before, manifest(live)), [], "byte-identical after a repeated run");
});

test("3. a git-linked live dir is refused (migrate metadata first), nothing written", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("w3"), "pi");
  mkdirSync(join(live, "agent"), { recursive: true });
  writeFileSync(join(live, "agent", "auth.json"), "SENTINEL");
  execFileSync("git", ["init", "-q", live]);
  const before = manifest(live);
  for (const args of [["--all", "--config-only"], ["--apply"]]) {
    const r = spawnSync("bash", [join(repo, "setup.sh"), ...args, "--target", join(live, "agent")], { encoding: "utf8" });
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /still git-linked — retire the worktree metadata first/);
  }
  assert.deepEqual(manifestDiff(before, manifest(live)), [], "nothing written by a refused run");
});

test("3b. symlinks are refused, never followed — copy side and field-aware side", () => {
  const repo = fixtureRepo();
  {
    // a symlink where a source-only file belongs: do not write through it
    const live = join(mktmp("w3b"), "pi");
    mkdirSync(join(live, "agent"), { recursive: true });
    const secret = join(live, "secret.json");
    writeFileSync(secret, "SENTINEL");
    symlinkSync(secret, join(live, "agent", "cloak.json"));
    const r = setupAll(repo, live);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REFUSED: +cloak\.json — symlinked path component/);
    assert.equal(readFileSync(secret, "utf8"), "SENTINEL", "nothing written through the symlink");
    assert.ok(lstatSync(join(live, "agent", "cloak.json")).isSymbolicLink(), "symlink itself untouched");
  }
  {
    // settings.json as a symlink: the field-aware writer refuses too
    const live = join(mktmp("w3b"), "pi");
    mkdirSync(join(live, "agent"), { recursive: true });
    const secret = join(live, "secret.json");
    writeFileSync(secret, JSON.stringify({ keep: true }));
    symlinkSync(secret, join(live, "agent", "settings.json"));
    const r = setupAll(repo, live);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing symlinked path component/);
    assert.equal(readFileSync(secret, "utf8"), JSON.stringify({ keep: true }));
  }
  {
    // a symlinked SOURCE file is refused as well
    const live = join(mktmp("w3b"), "pi");
    rmSync(join(repo, "agent", "cloak.json"));
    symlinkSync(join(live, "nowhere"), join(repo, "agent", "cloak.json"));
    const r = setupAll(repo, live);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REFUSED: +cloak\.json — symlinked path component/);
    assert.ok(!existsSync(join(live, "agent", "cloak.json")));
  }
});

test("4. malformed or non-object live JSON: refused, the file is never overwritten", () => {
  const repo = fixtureRepo();
  for (const [name, content] of [["settings.json", "{ not json"], ["mcp.json", "[1,2]"]] as const) {
    const live = join(mktmp("w4"), "pi");
    mkdirSync(join(live, "agent"), { recursive: true });
    writeFileSync(join(live, "agent", name), content);
    const r = spawnSync("bash", [join(repo, "setup.sh"), "--apply", "--target", join(live, "agent")], { encoding: "utf8" });
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /not valid JSON|not a JSON object/);
    assert.match(r.stderr, /not touching it/);
    assert.equal(readFileSync(join(live, "agent", name), "utf8"), content, "malformed file untouched");
  }
});

test("5. --dry-run on a fresh target writes nothing; --all needs an agent/ target", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("w5"), "pi");
  const dry = setupAll(repo, live, ["--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^DRY: /m);
  assert.ok(!existsSync(live), "nothing created");
  const bad = spawnSync("bash", [join(repo, "setup.sh"), "--all", "--config-only", "--target", join(live, "config")], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must be an agent\/ dir/);
});

test("6. machinery installs from the LIVE settings.json: a package added to source is applied and installed on re-run", () => {
  const repo = fixtureRepo();
  const home = mktmp("w7home");
  const live = join(home, ".pi");
  const bin = mktmp("w7bin");
  const trace = join(bin, "TRACE");
  for (const tool of ["pi", "npm", "mise", "gh", "agent-browser"]) {   // every machinery tool records its argv
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} \$*" >> "${trace}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  // PAWPRINT_PI_PKG: the PATH-stubbed `mise` must not break the settings writer's pi-package resolution
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_GATEWAY_ID: "y", PAWPRINT_PI_PKG: piPackageDir() };
  const run = () => spawnSync("bash", [join(repo, "setup.sh"), "--all"], { encoding: "utf8", env });
  const installs = () => readFileSync(trace, "utf8").split("\n").filter((l) => l.startsWith("pi install ")).map((l) => l.split(" ")[2]);
  const packages = (dir: string) => JSON.parse(readFileSync(join(dir, "agent", "settings.json"), "utf8")).packages
    .map((p: string | { source: string }) => (typeof p === "string" ? p : p.source));

  // an existing clone is NOT a skip reason: the native install reconciles pins
  mkdirSync(join(live, "agent", "git", "github.com", "tribble", "pawprint"), { recursive: true });
  let r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(installs(), packages(live), "first run: every package from the live settings.json");
  assert.ok(!r.stdout.includes("skip (present)"), "skip-if-clone-present is gone");

  // deploy: the source checkout gains a package; re-run applies it, then installs it
  const settings = JSON.parse(readFileSync(join(repo, "agent", "settings.json"), "utf8"));
  settings.packages.push("npm:@example/deployed-later");
  writeFileSync(join(repo, "agent", "settings.json"), JSON.stringify(settings, null, 2));
  rmSync(trace);
  r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(packages(live).includes("npm:@example/deployed-later"), "re-run applied the new package to live");
  assert.ok(installs().includes("npm:@example/deployed-later"), "re-run installs what the applied live settings have");
});

test("11. --list: JSON catalog on stdout only, one entry per manifest file, every `does` filled", () => {
  const files: string[] = JSON.parse(readFileSync(join(REPO, "manifest.json"), "utf8")).files;
  const r = spawnSetup(["--list"]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  const list: { path: string; does: string; needs: string[]; personal: boolean }[] = JSON.parse(r.stdout);
  assert.deepEqual(list.map((e) => e.path), files);
  for (const e of list) {
    assert.ok(e.does.trim(), `does: ${e.path}`);
    assert.ok(Array.isArray(e.needs) && typeof e.personal === "boolean", e.path);
  }
});

test("11b. --list on a TTY: prints a table (path, P, does), not JSON", () => {
  // `script` gives setup.sh a pseudo-TTY so [ -t 1 ] is true; col -b strips the
  // ^D/backspace/CR artifacts `script` emits. macOS-only (script/col syntax).
  const r = spawnSync("bash", ["-c", `script -q /dev/null bash "${join(REPO, "setup.sh")}" --list 2>/dev/null | col -b`], { encoding: "utf8", env: SETUP_ENV });
  if (r.status !== 0 || !r.stdout.trim()) return; // script/col unavailable — skip silently
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  assert.ok(lines[0]!.startsWith("path"), `table header, got: ${lines[0]!.trim()}`);
  assert.ok(r.stdout.includes("does"), "has the does column");
  assert.ok(r.stdout.includes("AGENTS.md"), "has a data row");
  assert.throws(() => JSON.parse(r.stdout), "TTY output is a table, not JSON");
});

test("12. --only: exactly the named files (+ backup of a differing one); unknown path exits 2 untouched; personal warns", () => {
  const t = mktmp("t12");
  const bad = spawnSetup(["--target", t, "--only", "cloak.json", "nope/x.ts"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /nope\/x\.ts/);
  assert.deepEqual([...manifest(t).keys()], [], "unknown path: nothing copied");
  // an empty arg is not a path: raw, it once selected the target dir itself and cp -a'd it into its own backup
  writeFileSync(join(t, "auth.json"), "SENTINEL");
  const empty = spawnSetup(["--target", t, "--only", "cloak.json", ""]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /not in manifest\.json files\[\]: ""/);
  assert.deepEqual([...manifest(t).keys()], ["auth.json"], "empty path: nothing copied, nothing backed up");
  rmSync(join(t, "auth.json"));

  mkdirSync(join(t, "configs"), { recursive: true });
  writeFileSync(join(t, "configs", "ws.json"), "// mine\n");
  const dry = runSetup(["--dry-run", "--target", t, "--only", "configs/ws.json", "cloak.json"]);
  assert.equal((dry.match(/^DRY: cp -a /gm) ?? []).length, 3, "plan: one backup + two copies");
  assert.deepEqual([...manifest(t).keys()], ["configs/ws.json"], "dry-run wrote nothing");

  const r = spawnSetup(["--target", t, "--only", "configs/ws.json", "cloak.json"]);
  assert.equal(r.status, 0, r.stderr);
  const got = [...manifest(t).keys()].sort();
  const bak = got.find((f) => f.startsWith("configs/ws.json.bak-pawprint-"));
  assert.ok(bak, "differing file was backed up");
  assert.deepEqual(got, ["configs/ws.json", bak!, "cloak.json"].sort(), "exactly the two files + the backup");
  assert.equal(readFileSync(join(t, bak!), "utf8"), "// mine\n");
  assert.equal(readFileSync(join(t, "configs", "ws.json"), "utf8"), readFileSync(join(PRINT, "configs", "ws.json"), "utf8"));
  assert.equal(r.stderr.trim(), "configs/ws.json encodes tribble's own choices — read it before you keep it", "personal file warns, non-personal is silent");
  assert.ok(!r.stdout.includes("Manual steps remain") && r.stdout.includes("machine machinery: SKIPPED"));

  const p = spawnSetup(["--target", t, "--only", "settings.json"]);
  assert.equal(p.status, 0);
  assert.equal(p.stderr.trim(), "settings.json encodes tribble's own choices — read it before you keep it");
  assert.ok(existsSync(join(t, "settings.json")), "personal file still installed");
});

test("12b. --only of settings.json/mcp.json shares the field-aware merge: managed win, unmanaged live values survive", () => {
  const t = mktmp("t12b");
  const srcSettings = JSON.parse(readFileSync(join(PRINT, "settings.json"), "utf8"));
  const srcMcp = JSON.parse(readFileSync(join(PRINT, "mcp.json"), "utf8"));
  writeFileSync(join(t, "settings.json"), JSON.stringify({
    defaultModel: "live/other-model",
    lastChangelogVersion: "999.0.0",
    editorPaddingX: 9,
  }));
  writeFileSync(join(t, "mcp.json"), JSON.stringify({
    mcpServers: {
      "slack-workos": { url: "https://wrong.example/mcp", enabled: false },
      "local-only": { command: "fake-server" },
    },
  }));
  const r = spawnSetup(["--target", t, "--only", "settings.json", "mcp.json"]);
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(readFileSync(join(t, "settings.json"), "utf8"));
  assert.equal(settings.defaultModel, srcSettings.defaultModel, "managed value wins");
  assert.equal(settings.lastChangelogVersion, "999.0.0", "runtime stamp survives");
  assert.equal(settings.editorPaddingX, 9, "live-only preference survives");
  const mcp = JSON.parse(readFileSync(join(t, "mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers["slack-workos"], { ...srcMcp.mcpServers["slack-workos"], enabled: false });
  assert.deepEqual(mcp.mcpServers["local-only"], { command: "fake-server" }, "live-only server survives");
});

test("13. no selector: bare setup.sh refuses (exit 2, pointer on stderr, target untouched); selector combos are refused too", () => {
  const t = mktmp("t13");
  writeFileSync(join(t, "auth.json"), "SENTINEL");
  const before = manifest(t);
  for (const args of [["--target", t], ["--dry-run", "--config-only", "--target", t]]) {
    const r = spawnSetup(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    for (const line of ["one person's pi config print", "--list", "--only <path>", "--all"])
      assert.ok(r.stderr.includes(line), `pointer mentions ${line}`);
  }
  for (const combo of [["--all", "--only", "cloak.json"], ["--all", "--apply"], ["--apply", "--only", "cloak.json"]]) {
    const r = spawnSetup(["--target", t, ...combo]);
    assert.equal(r.status, 2, combo.join(" "));
    assert.match(r.stderr, /exclusive/);
  }
  assert.deepEqual(manifestDiff(before, manifest(t)), [], "nothing written by any refused run");
});

test("3c. --apply refuses symlinked PARENT directories and writes nothing through them", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("w3c"), "pi");
  mkdirSync(live, { recursive: true });
  const elsewhere = join(mktmp("w3c-out"), "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(live, "agents"));
  const r = spawnSetup(["--apply", "--target", live]);
  assert.notEqual(r.status, 0, "refused");
  assert.match(r.stdout + r.stderr, /REFUSED:.*symlinked path component/);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");
  assert.equal(
    readFileSync(join(live, "AGENTS.md"), "utf8"),
    readFileSync(join(repo, "agent", "AGENTS.md"), "utf8"),
    "earlier files still applied (per-file fail-closed, non-transactional)",
  );
});

test("3d. --apply refuses a hardlinked destination without touching the linked file", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("w3d"), "pi");
  mkdirSync(live, { recursive: true });
  const sentinel = join(mktmp("w3d-sentinel"), "sentinel.txt");
  writeFileSync(sentinel, "sentinel\n");
  execFileSync("ln", [sentinel, join(live, "cloak.json")]);
  const r = spawnSetup(["--apply", "--target", live]);
  assert.notEqual(r.status, 0, "refused");
  assert.match(r.stdout + r.stderr, /REFUSED:.*hardlinked/);
  assert.equal(readFileSync(sentinel, "utf8"), "sentinel\n", "linked file untouched");
});

test("3e. --apply refuses a directory where a managed file belongs (no copy INTO the collision)", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("w3e"), "pi");
  mkdirSync(join(live, "AGENTS.md"), { recursive: true });
  const r = spawnSetup(["--apply", "--target", live]);
  assert.notEqual(r.status, 0, "refused");
  assert.match(r.stdout + r.stderr, /REFUSED:.*not a regular file/);
  assert.deepEqual(readdirSync(join(live, "AGENTS.md")), [], "no AGENTS.md/AGENTS.md");
});

test("5b. --all --dry-run needs no pi/mise/npm installation and writes nothing", () => {
  const repo = fixtureRepo();
  const live = join(mktmp("w5b"), "pi");
  // a PATH with no mise/npm/pi: only node (symlinked real binary), jq and git
  const realbin = mktmp("w5b-realbin");
  symlinkSync(realpathSync(process.execPath), join(realbin, "node"));
  const env = {
    PATH: `${realbin}:/usr/bin:/bin`,
    HOME: mktmp("w5b-home"),
    CLOUDFLARE_ACCOUNT_ID: "x",
    CLOUDFLARE_GATEWAY_ID: "y",
  };
  const r = spawnSync("bash", [join(repo, "setup.sh"), "--all", "--dry-run", "--target", join(live, "agent")], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY: .*apply-config\.ts settings/);
  assert.ok(!existsSync(live), "nothing created");
});

test("6b. fresh-machine --all bootstraps the runtime BEFORE the settings apply (no PAWPRINT_PI_PKG, mise cannot resolve)", () => {
  const repo = fixtureRepo();
  const home = mktmp("w6b-home");
  const live = join(home, ".pi");
  mkdirSync(join(live, "agent"), { recursive: true });
  writeFileSync(join(live, "agent", "auth.json"), "LIVE-AUTH\n");
  const bin = mktmp("w6b-bin");
  const realbin = mktmp("w6b-realbin");
  symlinkSync(realpathSync(process.execPath), join(realbin, "node"));
  const trace = join(bin, "TRACE");
  const fakeroot = join(bin, "npm-global");
  // mise: `where` fails (pi not mise-installed here); other subcommands succeed
  writeFileSync(join(bin, "mise"), '#!/bin/sh\ncase "$1" in where) exit 1;; *) echo "mise $*" >> "$TRACE";; esac\nexit 0\n');
  // npm: `root -g` answers; `install -g` materializes the package (symlink to the real one) and a pi shim
  writeFileSync(join(bin, "npm"), `#!/bin/sh
if [ "$1" = "root" ]; then echo "${fakeroot}"; exit 0; fi
echo "npm $*" >> "$TRACE"
if [ "$1" = "install" ]; then
  mkdir -p "${fakeroot}/@earendil-works"
  ln -sfn "${piPackageDir()}" "${fakeroot}/@earendil-works/pi-coding-agent"
  cat > "${bin}/pi" <<'STUB'
#!/bin/sh
echo "pi $*" >> "$TRACE"
STUB
  chmod +x "${bin}/pi"
fi
exit 0
`);
  for (const tool of ["gh", "agent-browser"]) writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} \\$*" >> "${trace}"\n`);
  for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755);
  const env = {
    PATH: `${bin}:${realbin}:/usr/bin:/bin`,
    HOME: home,
    TRACE: trace,
    CLOUDFLARE_ACCOUNT_ID: "x",
    CLOUDFLARE_GATEWAY_ID: "y",
    // deliberately NO PAWPRINT_PI_PKG: the apply must resolve via the bootstrap's install
  };
  const r = spawnSync("bash", [join(repo, "setup.sh"), "--all"], { encoding: "utf8", env });
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  const t = readFileSync(trace, "utf8");
  const lines = t.split("\n");
  const npmInstall = lines.findIndex((l) => l.includes("npm install -g @earendil-works/pi-coding-agent"));
  const firstPiInstall = lines.findIndex((l) => l.startsWith("pi install git:"));
  assert.ok(npmInstall >= 0, "bootstrap installed pi");
  assert.ok(firstPiInstall > npmInstall, "package installs run after the bootstrap");
  const settings = JSON.parse(readFileSync(join(live, "agent", "settings.json"), "utf8"));
  const srcPackages = JSON.parse(readFileSync(join(repo, "agent", "settings.json"), "utf8")).packages;
  assert.deepEqual(settings.packages, srcPackages, "settings applied — resolved the bootstrapped package without PAWPRINT_PI_PKG or mise");
  assert.equal(readFileSync(join(live, "agent", "auth.json"), "utf8"), "LIVE-AUTH\n");
});

test("6g. missing pi runtime: --apply and managed --only refuse before ANY write; --dry-run and source-only --only still work", () => {
  const home = mktmp("w6f-home");
  const bin = mktmp("w6f-bin");
  const realbin = mktmp("w6f-realbin");
  symlinkSync(realpathSync(process.execPath), join(realbin, "node"));
  symlinkSync(realpathSync(execFileSync("which", ["jq"], { encoding: "utf8" }).trim()), join(realbin, "jq"));
  // no pi anywhere: mise/npm cannot resolve it, no pi shim on PATH, no PAWPRINT_PI_PKG
  for (const tool of ["mise", "npm"]) {
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, tool), 0o755);
  }
  const env = { PATH: `${bin}:${realbin}:/usr/bin:/bin`, HOME: home, GIT_DIR };
  const setup = (args: string[]) => spawnSync("bash", [join(REPO, "setup.sh"), ...args], { encoding: "utf8", env });

  // --apply refuses before ANY manifest write — even the source-only files
  // that precede mcp.json in the manifest; the live tree stays byte-identical
  const live = join(mktmp("w6f-apply"), "agent");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "auth.json"), "LIVE-AUTH\n");
  const before = manifest(live);
  const r = setup(["--apply", "--target", live]);
  assert.notEqual(r.status, 0, "must refuse without pi's runtime");
  assert.match(r.stderr, /pi's installed package not found|PAWPRINT_PI_PKG/);
  assert.deepEqual(manifestDiff(before, manifest(live)), [], "zero manifest writes, earlier source-only files included");

  // --dry-run never resolves the runtime
  const dry = setup(["--apply", "--dry-run", "--target", live]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY: .*apply-config\.ts/);
  assert.deepEqual(manifestDiff(before, manifest(live)), [], "dry-run wrote nothing");

  // source-only --only: no runtime needed, current prerequisites unchanged
  const t1 = mktmp("w6f-only-src");
  const src = setup(["--target", t1, "--only", "cloak.json"]);
  assert.equal(src.status, 0, src.stderr);
  assert.ok(existsSync(join(t1, "cloak.json")));

  // --only naming a managed JSON: preflight refuses before the first SELECTED
  // write — a source-only selection listed first is not written either
  const t2 = mktmp("w6f-only-mcp");
  const managed = setup(["--target", t2, "--only", "cloak.json", "mcp.json"]);
  assert.notEqual(managed.status, 0);
  assert.match(managed.stderr, /pi's installed package not found|PAWPRINT_PI_PKG/);
  assert.deepEqual([...manifest(t2).keys()], [], "nothing selected was written");
});

// 6c–6e: package installation after a successful apply, on the DEFAULT live
// target (a synthetic HOME). `pi` and the machinery tools are PATH stubs that
// trace every invocation ($TRACE comes from the env) — no real installs, ever.
const srcPackageEntries: (string | { source: string })[] = JSON.parse(readFileSync(join(PRINT, "settings.json"), "utf8")).packages;
const srcPackageSources = srcPackageEntries.map((p) => (typeof p === "string" ? p : p.source));
function pkgStubHome(piStub: string) {
  const home = mktmp("w6pkg");
  const bin = mktmp("w6pkg-bin");
  const trace = join(bin, "TRACE");
  writeFileSync(join(bin, "pi"), piStub);
  for (const tool of ["npm", "mise", "gh", "agent-browser"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} \$*" >> "$TRACE"\n`);
  }
  for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    TRACE: trace,
    PAWPRINT_PI_PKG: piPackageDir(), // the settings writer must not probe the stubbed mise/npm
  };
  return { home, live: join(home, ".pi", "agent"), trace, env };
}

test("6c. --apply on the default live target: native install of every APPLIED package, after the merge", () => {
  const repo = fixtureRepo();
  const { live, trace, env } = pkgStubHome('#!/bin/sh\necho "pi dir=$PI_CODING_AGENT_DIR :: $*" >> "$TRACE"\n');
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "auth.json"), "LIVE-AUTH\n");
  // a live config pi ran against: runtime stamp + a package the source does not declare
  writeFileSync(join(live, "settings.json"), JSON.stringify({
    defaultModel: "live/other-model",
    lastChangelogVersion: "999.0.0",
    packages: ["git:github.com/live/unrelated"],
  }));
  const r = spawnSync("bash", [join(repo, "setup.sh"), "--apply"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr + r.stdout);

  // the applied settings carry the source's list with object-form filters intact
  const applied = JSON.parse(readFileSync(join(live, "settings.json"), "utf8"));
  assert.deepEqual(applied.packages, srcPackageEntries, "applied list == source list, filters preserved");
  assert.equal(applied.lastChangelogVersion, "999.0.0", "runtime sentinel survives");
  assert.equal(readFileSync(join(live, "auth.json"), "utf8"), "LIVE-AUTH\n");

  // the installs read the APPLIED list: source-only entries appear, the
  // pre-apply live-only package does not (the merge replaced the array first)
  const lines = readFileSync(trace, "utf8").split("\n").filter(Boolean);
  const installs = lines.filter((l) => l.startsWith("pi "));
  assert.deepEqual(
    installs.map((l) => l.replace(/^pi dir=\S+ :: install /, "").replace(/ --no-approve$/, "")),
    srcPackageSources,
    "every applied source installed, in declared order",
  );
  for (const l of installs) {
    assert.ok(l.startsWith(`pi dir=${live} :: `), "PI_CODING_AGENT_DIR binds the install to the target");
    assert.match(l, / :: install \S+ --no-approve$/, "the native CLI contract, nothing else");
  }
  assert.ok(!installs.some((l) => l.includes("live/unrelated")), "a live-only package is never installed");
  assert.equal(lines.length, installs.length, "--apply runs no bootstrap and no machinery tools");
  assert.ok(r.stdout.includes("machine machinery: SKIPPED (--apply)"));
  assert.ok(!r.stdout.includes("package installation: SKIPPED"), "default-target --apply installs");
});

test("6d. a failed package install: nonzero, config stays applied, failed source + concrete retry named, later sources never attempted", () => {
  const repo = fixtureRepo();
  const { live, trace, env } = pkgStubHome('#!/bin/sh\necho "pi $*" >> "$TRACE"\ncase "$*" in *pi-stash*) exit 1;; esac\n');
  const failedSrc = srcPackageSources.find((s) => s.includes("pi-stash"));
  assert.ok(failedSrc, "fixture source list has pi-stash");
  const r = spawnSync("bash", [join(repo, "setup.sh"), "--apply"], { encoding: "utf8", env });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /config applied.*incomplete/is);
  assert.ok(r.stderr.includes(failedSrc!), "names the failed source");
  assert.match(r.stderr, /setup\.sh --apply/, "names the concrete retry");

  const attempted = readFileSync(trace, "utf8");
  assert.ok(attempted.includes("pi-stash"), "the failing install was attempted");
  assert.ok(!attempted.includes("pi-answer"), "stops at the FIRST failure (pi-answer sorts later in the list)");

  // partial state is truthful: the config WAS applied, nothing rolled back, no success tail
  const applied = JSON.parse(readFileSync(join(live, "settings.json"), "utf8"));
  assert.deepEqual(applied.packages, srcPackageEntries, "config applied before the failure — never rolled back");
  assert.ok(!r.stdout.includes("machine machinery: SKIPPED (--apply)") && !r.stdout.includes("Done."), "no success claim after a failed install");
});

test("6e. package installs skip truthfully: --config-only, --dry-run, non-default target", () => {
  const repo = fixtureRepo();
  for (const extra of [["--apply", "--config-only"], ["--all", "--dry-run"]]) {
    const { trace, env } = pkgStubHome('#!/bin/sh\necho "pi $*" >> "$TRACE"\n');
    const r = spawnSync("bash", [join(repo, "setup.sh"), ...extra], { encoding: "utf8", env });
    assert.equal(r.status, 0, `${extra}: ${r.stderr}${r.stdout}`);
    assert.match(r.stdout, /package installation: SKIPPED/, extra.join(" "));
    assert.ok(!existsSync(trace), `no installer ran under ${extra.join(" ")}`);
  }
  // --apply no longer implies --config-only; a non-default target must still skip
  {
    const { trace, env } = pkgStubHome('#!/bin/sh\necho "pi $*" >> "$TRACE"\n');
    const elsewhere = join(mktmp("w6e-else"), "agent");
    const r = spawnSync("bash", [join(repo, "setup.sh"), "--apply", "--target", elsewhere], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /package installation: SKIPPED/);
    assert.ok(!existsSync(trace), "no installer ran against a non-default target");
  }
});

test("6f. --all package failure: the printed retry preserves --all; following it runs the remaining machinery, no false completion", () => {
  const repo = fixtureRepo();
  // pi fails on pi-stash exactly once (marker file): the retry succeeds
  const { trace, env } = pkgStubHome(
    '#!/bin/sh\necho "pi $*" >> "$TRACE"\ncase "$*" in *pi-stash*) [ -f "${TRACE}.failed-once" ] || { touch "${TRACE}.failed-once"; exit 1; } ;; esac\n',
  );
  const allEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_GATEWAY_ID: "y" };
  const failed = spawnSync("bash", [join(repo, "setup.sh"), "--all"], { encoding: "utf8", env: allEnv });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /package installation INCOMPLETE/);
  const retry = /retry: (\S+) (--\w+)/.exec(failed.stderr);
  assert.ok(retry, "a concrete retry is printed");
  assert.equal(retry![2], "--all", "the retry preserves --all — --apply would drop the remaining bootstrap/machinery");
  assert.ok(!failed.stdout.includes("Done."), "no false completion");
  const before = readFileSync(trace, "utf8");
  assert.ok(before.includes("pi install"), "package installs ran before the failure");
  assert.ok(!before.includes("agent-browser") && !/^gh /m.test(before), "machinery past the failure point never ran");

  // follow the printed retry literally: the remaining machinery runs, the run completes
  const retried = spawnSync("bash", [retry![1]!, retry![2]!], { encoding: "utf8", env: allEnv });
  assert.equal(retried.status, 0, retried.stderr + retried.stdout);
  assert.match(retried.stdout, /Done\./);
  const after = readFileSync(trace, "utf8");
  assert.ok(after.includes("agent-browser install"), "retry ran the remaining machinery (agent-browser)");
  assert.ok(after.includes("gh extension install"), "retry ran the remaining machinery (gh)");
});

test("12c. --only on the default live target overwrites WITHOUT backups (never copies live files)", () => {
  const home = mktmp("w12c");
  const live = join(home, ".pi", "agent");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "AGENTS.md"), "live drift\n");
  const r = spawnSync("bash", [join(REPO, "setup.sh"), "--only", "AGENTS.md"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_DIR },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(live, "AGENTS.md"), "utf8"), readFileSync(join(PRINT, "AGENTS.md"), "utf8"), "source wins");
  assert.ok(!readdirSync(live).some((f) => f.includes(".bak-pawprint-")), "no backup of a live file");
});

test("3f. path aliases cannot bypass the guards: trailing slash, /., case alias, locked-worktree root", () => {
  const repo = fixtureRepo();
  // trailing slash on a SYMLINKED target dir — `-L "dir/"` follows the link; the guard must not
  {
    const live = join(mktmp("w3f"), "pi");
    const elsewhere = join(mktmp("w3f-out"), "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, live);
    const r = spawnSetup(["--only", "cloak.json", "--target", live + "/"]);
    assert.notEqual(r.status, 0, "trailing slash must not bypass the symlink guard");
    assert.match(r.stderr, /symlinked path component/);
    assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");
  }
  // git-linked live under aliased spellings (review: agent/. applied while .git remained)
  {
    const live = join(mktmp("w3f-git"), "pi");
    mkdirSync(join(live, "agent"), { recursive: true });
    writeFileSync(join(live, "agent", "auth.json"), "SENTINEL");
    execFileSync("git", ["init", "-q", live]);
    // string concatenation, not path.join: join() would normalize the aliases away
    for (const spelling of [`${live}/agent/.`, `${live}/agent/`]) {
      const r = spawnSetup(["--apply", "--target", spelling]);
      assert.equal(r.status, 1, spelling);
      assert.match(r.stderr, /still git-linked/);
    }
    // a '..' spelling never reaches the git-link check: refused at the door
    const dd = spawnSetup(["--apply", "--target", `${live}/agent/../agent`]);
    assert.equal(dd.status, 2);
    assert.match(dd.stderr, /'\.\.'.*without \.\./);
    assert.equal(readFileSync(join(live, "agent", "auth.json"), "utf8"), "SENTINEL", "refusal wrote nothing");
  }
  // an existing LOCKED worktree root (.git is a gitfile) under an aliased target
  {
    const live = join(mktmp("w3f-wt"), "pi");
    git(repo, "switch", "-q", "--detach");
    git(repo, "worktree", "add", "-q", "--lock", live, "main");
    writeFileSync(join(live, "agent", "auth.json"), "SENTINEL");
    const r = spawnSetup(["--apply", "--target", `${live}/agent/.`]);
    assert.equal(r.status, 1, "aliased target on a locked worktree must still refuse");
    assert.match(r.stderr, /still git-linked/);
  }
  // case alias on a case-insensitive filesystem: git-link detection goes through the FS
  {
    const live = join(mktmp("w3f-case"), "Pi");
    mkdirSync(join(live, "AGENT"), { recursive: true });
    execFileSync("git", ["init", "-q", live]);
    const aliased = join(live.toLowerCase(), "agent");
    if (existsSync(aliased)) {
      const r = spawnSetup(["--apply", "--target", aliased]);
      assert.equal(r.status, 1, "case alias must not bypass git-link detection");
      assert.match(r.stderr, /still git-linked/);
    }
  }
});

test("3h. a symlinked config ROOT (~/.pi) is refused, not silently followed", () => {
  const repo = fixtureRepo();
  const home = mktmp("w3h");
  const real = join(home, "real");
  mkdirSync(join(real, "agent"), { recursive: true });
  symlinkSync(real, join(home, ".pi"));
  const r = spawnSync("bash", [join(repo, "setup.sh"), "--apply", "--target", join(home, ".pi", "agent")], { encoding: "utf8", env: SETUP_ENV });
  assert.notEqual(r.status, 0, "symlinked config root refused");
  assert.match(r.stderr + r.stdout, /REFUSED:.*symlinked path component/);
  assert.deepEqual(readdirSync(join(real, "agent")), [], "nothing written through the root link");
});

test("12d. the no-backup policy keys on the real live directory, not its spelling", () => {
  const home = mktmp("w12d");
  const live = join(home, ".pi", "agent");
  mkdirSync(live, { recursive: true });
  const source = readFileSync(join(PRINT, "AGENTS.md"), "utf8");
  const spellings = [
    `${live}/`,
    `${home}/.pi/./agent`,
    `${home}/.pi/agent/.`,
  ];
  const caseAlias = `${home}/.PI/AGENT`;
  if (existsSync(caseAlias)) spellings.push(caseAlias);
  for (const t of spellings) {
    writeFileSync(join(live, "AGENTS.md"), "live drift\n");
    const r = spawnSync("bash", [join(REPO, "setup.sh"), "--only", "AGENTS.md", "--target", t], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, GIT_DIR },
    });
    assert.equal(r.status, 0, `${t}: ${r.stderr}`);
    assert.equal(readFileSync(join(live, "AGENTS.md"), "utf8"), source, `${t} applied to the real live dir`);
    assert.ok(!readdirSync(live).some((f) => f.includes(".bak-pawprint-")), `no backup via ${t}`);
  }
  // relative spelling, resolved against the caller's cwd
  writeFileSync(join(live, "AGENTS.md"), "live drift\n");
  const rel = spawnSync("bash", [join(REPO, "setup.sh"), "--only", "AGENTS.md"], {
    encoding: "utf8",
    cwd: join(home, ".pi"),
    env: { ...process.env, HOME: home, GIT_DIR, PAWPRINT_TARGET: "agent" },
  });
  assert.equal(rel.status, 0, rel.stderr);
  assert.equal(readFileSync(join(live, "AGENTS.md"), "utf8"), source, "relative spelling applied to the real live dir");
  assert.ok(!readdirSync(live).some((f) => f.includes(".bak-pawprint-")), "no backup via the relative spelling");

  // a '..' spelling is refused outright (deliberate safe refusal — lexical
  // collapse through a symlink would silently pick a different directory)
  writeFileSync(join(live, "AGENTS.md"), "live drift\n");
  const dd = spawnSync("bash", [join(REPO, "setup.sh"), "--only", "AGENTS.md", "--target", `${home}/.pi/x/../agent`], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_DIR },
  });
  assert.equal(dd.status, 2);
  assert.match(dd.stderr, /'\.\.'.*without \.\./);
  assert.equal(readFileSync(join(live, "AGENTS.md"), "utf8"), "live drift\n", "refusal wrote nothing");
});

test("12f. no-backup identity follows a symlinked live dir (BSD stat lstats by default)", () => {
  const home = mktmp("w12f");
  const real = join(home, "realagent");
  mkdirSync(join(home, ".pi"), { recursive: true });
  mkdirSync(real, { recursive: true });
  symlinkSync(real, join(home, ".pi", "agent")); // ~/.pi/agent → the real dir
  writeFileSync(join(real, "AGENTS.md"), "live drift\n");
  const r = spawnSync("bash", [join(REPO, "setup.sh"), "--only", "AGENTS.md", "--target", real], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_DIR },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(real, "AGENTS.md"), "utf8"), readFileSync(join(PRINT, "AGENTS.md"), "utf8"), "source wins");
  assert.ok(!readdirSync(real).some((f) => f.includes(".bak-pawprint-")), "a symlink alias of the live dir is still the live dir — no backup");
});

test("12g. a failing stat makes identity UNKNOWN: --only aborts — no backup, no copy, live bytes preserved", () => {
  const home = mktmp("w12g");
  const live = join(home, ".pi", "agent");
  mkdirSync(live, { recursive: true });
  const drift = "live drift\n";
  writeFileSync(join(live, "AGENTS.md"), drift);
  // a case alias differs as a STRING, so identity falls through to stat
  const caseAlias = join(home, ".PI", "AGENT");
  if (!existsSync(caseAlias)) return; // case-sensitive volume: the alias scenario is moot
  const bin = mktmp("w12g-bin");
  writeFileSync(join(bin, "stat"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "stat"), 0o755);
  const r = spawnSync("bash", [join(REPO, "setup.sh"), "--only", "AGENTS.md", "--target", caseAlias], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_DIR, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.notEqual(r.status, 0, "identity error must abort the copy");
  assert.match(r.stderr, /cannot confirm/);
  assert.equal(readFileSync(join(live, "AGENTS.md"), "utf8"), drift, "live file untouched");
  assert.ok(!readdirSync(live).some((f) => f.includes(".bak-pawprint-")), "no prohibited backup of a live file");
});

test("12h. newline-HOME with the live dir symlinked: identity error aborts — no backup, bytes preserved", () => {
  const scratch = mktmp("w12h");
  const home = join(scratch, "ho\nme"); // HOME itself contains a newline
  const real = join(scratch, "realagent"); // the newline-free real live dir, passed as --target
  mkdirSync(join(home, ".pi"), { recursive: true });
  mkdirSync(real, { recursive: true });
  symlinkSync(real, join(home, ".pi", "agent")); // ~/.pi/agent → real
  const drift = "live drift\n";
  writeFileSync(join(real, "AGENTS.md"), drift);
  const r = spawnSync("bash", [join(REPO, "setup.sh"), "--only", "AGENTS.md", "--target", real], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_DIR },
  });
  assert.notEqual(r.status, 0, "identity error must abort the copy");
  assert.match(r.stderr, /newline|cannot confirm/);
  assert.equal(readFileSync(join(real, "AGENTS.md"), "utf8"), drift, "live file untouched");
  assert.ok(!readdirSync(real).some((f) => f.includes(".bak-pawprint-")), "no prohibited backup of a live file");
});

test("3i. a literal wildcard in --target is never glob-expanded against the checkout", () => {
  const repo = fixtureRepo();
  const scratch = mktmp("w3i");
  const literal = join(scratch, "a*"); // quoted argv: a directory literally named a*
  const r = spawnSync("bash", [join(repo, "setup.sh"), "--apply", "--target", join(literal, "agent")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(literal, "agent", "AGENTS.md")), "files landed in the literal a* dir");
  assert.ok(!existsSync(join(scratch, "agent")), "never expanded to the checkout's agent/ match");
});

test("3j. an empty --target (flag or env) is refused at the door — never the caller's cwd", () => {
  const repo = fixtureRepo();
  const cwd = mktmp("w3j");
  writeFileSync(join(cwd, "AGENTS.md"), "sentinel\n");
  const r = spawnSync("bash", [join(repo, "setup.sh"), "--apply", "--target", ""], { encoding: "utf8", cwd });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty --target/);
  assert.deepEqual(readdirSync(cwd).sort(), ["AGENTS.md"], "nothing applied into the caller's cwd");
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), "sentinel\n");
  const env = spawnSync("bash", [join(repo, "setup.sh"), "--apply"], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, PAWPRINT_TARGET: "../elsewhere" },
  });
  assert.equal(env.status, 2);
  assert.match(env.stderr, /'\.\.'.*without \.\./);
  assert.deepEqual(readdirSync(cwd).sort(), ["AGENTS.md"], "env refusal wrote nothing either");
});

test("3k. a newline in --target is refused at the door — never truncated to the prefix", () => {
  // read -ra stops at the first newline: '<applied>/agent\nignored' used to
  // normalize to the applied live dir itself — applied to / validated as a
  // directory the caller never named.
  const repo = fixtureRepo();
  const scratch = mktmp("w3k");
  const live = join(scratch, "pi");
  const applied = setupAll(repo, live);
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  const wrongPrefix = join(live, "agent");            // what the truncation resolves to
  const prefixAgents = readFileSync(join(wrongPrefix, "AGENTS.md"), "utf8");
  const requested = `${wrongPrefix}\nignored`;        // the path actually requested
  mkdirSync(requested, { recursive: true });
  writeFileSync(join(requested, "AGENTS.md"), "requested sentinel\n");

  const flag = spawnSync("bash", [join(repo, "setup.sh"), "--apply", "--target", requested], { encoding: "utf8" });
  assert.equal(flag.status, 2, flag.stderr);
  assert.match(flag.stderr, /newline/);
  const env = spawnSync("bash", [join(repo, "setup.sh"), "--apply"], {
    encoding: "utf8",
    env: { ...process.env, PAWPRINT_TARGET: requested },
  });
  assert.equal(env.status, 2, env.stderr);
  assert.match(env.stderr, /newline/);
  assert.equal(readFileSync(join(wrongPrefix, "AGENTS.md"), "utf8"), prefixAgents, "wrong-prefix live dir untouched");
  assert.equal(readFileSync(join(requested, "AGENTS.md"), "utf8"), "requested sentinel\n", "requested path untouched");

  const v = spawnSync("bash", [join(repo, "scripts", "validate.sh"), "--target", requested], {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "SENTINEL-ACCOUNT-9f8", CLOUDFLARE_GATEWAY_ID: "SENTINEL-GATEWAY-2b7" },
  });
  assert.equal(v.status, 2, v.stdout);
  assert.doesNotMatch(v.stdout, /VALID/, "validate must never VALIDate the truncated prefix");
});

test("3l. a relative target from a newline-containing cwd is refused — the composed path is never truncated", () => {
  // 'agent' has no newline, so the raw-target refusal passes; normalize_dir
  // then prepends the caller's cwd ('<scratch>/prefix\nsuffix') and read
  // truncated the composed path to the wrong prefix.
  const repo = fixtureRepo();
  const scratch = mktmp("w3l");
  const wrongPrefix = join(scratch, "prefix"); // the truncation result: a fully applied live dir
  {
    const applied = spawnSync("bash", [join(repo, "setup.sh"), "--apply", "--target", wrongPrefix], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  }
  const prefixAgents = readFileSync(join(wrongPrefix, "AGENTS.md"), "utf8");
  const cwd = join(scratch, "prefix\nsuffix"); // the caller's cwd holds the newline
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "marker.txt"), "requested sentinel\n");

  const flag = spawnSync("bash", [join(repo, "setup.sh"), "--apply", "--target", "agent"], { encoding: "utf8", cwd });
  assert.equal(flag.status, 2, flag.stderr);
  assert.match(flag.stderr, /newline/);
  assert.equal(readFileSync(join(wrongPrefix, "AGENTS.md"), "utf8"), prefixAgents, "wrong-prefix live dir untouched");
  assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "requested sentinel\n");
  assert.ok(!existsSync(join(cwd, "agent")), "nothing applied at the requested path");

  const v = spawnSync("bash", [join(repo, "scripts", "validate.sh"), "--target", "agent"], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "SENTINEL-ACCOUNT-9f8", CLOUDFLARE_GATEWAY_ID: "SENTINEL-GATEWAY-2b7" },
  });
  assert.equal(v.status, 2, v.stdout);
  assert.doesNotMatch(v.stdout, /VALID/, "validate must never VALIDate the truncated prefix");
});

test("12e. a missing or invalid selected source refuses — no success without application", () => {
  const home = mktmp("w12e");
  const live = join(home, ".pi", "agent");
  mkdirSync(live, { recursive: true });
  const run = (repo: string, ...paths: string[]) =>
    // PAWPRINT_PI_PKG: a managed --only preflights the runtime first; this scratch
    // HOME hides the real one, and the cases below test SOURCE refusals, not runtime
    // absence (6g covers that) — so hand the probe the package directly.
    spawnSync("bash", [join(repo, "setup.sh"), "--only", ...paths], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, GIT_DIR, PAWPRINT_PI_PKG: piPackageDir() },
    });
  // source is a directory
  {
    const repo = fixtureRepo();
    rmSync(join(repo, "agent", "settings.json"));
    mkdirSync(join(repo, "agent", "settings.json"));
    const r = run(repo, "settings.json");
    assert.notEqual(r.status, 0, "directory source refuses");
    assert.match(r.stderr, /REFUSED:.*settings\.json/);
    assert.ok(!existsSync(join(live, "settings.json")), "nothing applied");
  }
  // source is a dangling symlink (json side and source-only side)
  {
    const repo = fixtureRepo();
    rmSync(join(repo, "agent", "mcp.json"));
    symlinkSync(join(repo, "agent", "nowhere"), join(repo, "agent", "mcp.json"));
    const r = run(repo, "mcp.json");
    assert.notEqual(r.status, 0, "dangling json source refuses");
    assert.match(r.stderr, /REFUSED:.*mcp\.json|refusing symlinked/);
  }
  {
    const repo = fixtureRepo();
    rmSync(join(repo, "agent", "cloak.json"));
    symlinkSync(join(repo, "agent", "nowhere"), join(repo, "agent", "cloak.json"));
    const r = run(repo, "cloak.json");
    assert.notEqual(r.status, 0, "dangling source-only source refuses");
    assert.ok(!existsSync(join(live, "cloak.json")), "nothing applied");
  }
  // source missing entirely
  {
    const repo = fixtureRepo();
    rmSync(join(repo, "agent", "presets.json"));
    const r = run(repo, "presets.json");
    assert.notEqual(r.status, 0, "missing source refuses");
    assert.match(r.stderr, /REFUSED:.*presets\.json/);
    assert.ok(!existsSync(join(live, "presets.json")), "nothing applied");
  }
});
