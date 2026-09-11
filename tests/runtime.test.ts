// runtime: setup.sh's machine machinery writes a static ~/.local/bin/pi
// launcher that execs the manifest's pinned node directly — pi never runs on
// whatever the cwd's toolchain (direnv/flake/.nvmrc) resolves. Runs the REAL
// setup.sh under a temp HOME with stubbed machinery tools (trace pattern from
// imprint.test.ts case 8): nothing touches the live machine.
//
// Env is built EXPLICITLY (never a process.env spread): an inherited
// PAWPRINT_TARGET would redirect setup.sh's target out of the temp HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync,
  statSync, lstatSync, existsSync, symlinkSync, readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const PIN: string = JSON.parse(readFileSync(join(REPO, "manifest.json"), "utf8")).runtime.node;

function mktmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Stub the machinery tools. `mise install node@X` fabricates a fake pinned
// node under $HOME. The fake node mirrors the REAL wiring this feature relies
// on: bin/npm is a shim that execs bare `node` from PATH (so prefix follows
// process.execPath — the bug shape), while `node <npm-cli.js> --prefix P`
// honors the explicit prefix. A test stub that derived the prefix from its own
// file location hid exactly this.
function writeFakePinnedNode(path: string, trace: string) {
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "--version" ]; then echo v${PIN}; exit 0; fi
case "$1" in
  */npm-cli.js)
    shift
    prefix=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --prefix) prefix="$2"; shift 2;;
        *) shift;;
      esac
    done
    echo "pinned-node npm-cli prefix=$prefix" >> "${trace}"
    pid="$prefix/lib/node_modules/@earendil-works/pi-coding-agent"
    mkdir -p "$pid/dist/bundle"
    echo "// fake bundle" > "$pid/dist/bundle/cli.js"
    printf '{"engines":{"node":">=22.19.0"}}\\n' > "$pid/package.json"
    ;;
esac
`);
  chmodSync(path, 0o755);
}
function makeStubs(bin: string, trace: string) {
  for (const tool of ["pi", "gh", "agent-browser"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $@" >> "${trace}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  // foreign npm: its global root is a FOREIGN toolchain prefix — anything
  // derived from `npm root -g` must never leak into the pinned setup
  writeFileSync(join(bin, "npm"), `#!/bin/sh
echo "npm $@" >> "${trace}"
if [ "$1" = "root" ]; then echo "$HOME/foreign-node/lib/node_modules"; fi
`);
  chmodSync(join(bin, "npm"), 0o755);
  // fixture parts the mise stub copies into the fabricated node install
  writeFakePinnedNode(join(bin, "fixture-node"), trace);
  writeFileSync(join(bin, "fixture-npm-shim"), `#!/bin/sh
# like the real mise npm shim: execs whatever node PATH resolves
here=$(cd "$(dirname "$0")/.." && pwd)
exec node "$here/lib/node_modules/npm/bin/npm-cli.js" "$@"
`);
  writeFileSync(join(bin, "fixture-npm-cli.js"), "// placeholder — the fake node dispatches on this path\n");
  writeFileSync(join(bin, "mise"), `#!/bin/sh
echo "mise $@" >> "${trace}"
if [ "$1" = "install" ]; then
  ver=\${2#node@}
  if [ -n "$2" ] && [ "$ver" != "$2" ]; then
    N="$HOME/.local/share/mise/installs/node/$ver"
    mkdir -p "$N/bin" "$N/lib/node_modules/npm/bin"
    cp "${bin}/fixture-node" "$N/bin/node"
    chmod 755 "$N/bin/node"
    cp "${bin}/fixture-npm-shim" "$N/bin/npm"
    chmod 755 "$N/bin/npm"
    cp "${bin}/fixture-npm-cli.js" "$N/lib/node_modules/npm/bin/npm-cli.js"
  fi
fi
`);
  chmodSync(join(bin, "mise"), 0o755);
}
// Stub mise that can never provide a node (finding 1: setup must FAIL then).
function makeStubsNoNode(bin: string, trace: string) {
  for (const tool of ["pi", "npm", "mise", "gh", "agent-browser"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $@" >> "${trace}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
}

// Explicit env: no process.env spread, so inherited PAWPRINT_* can't leak in;
// PAWPRINT_TARGET pinned to the temp default target (setup.sh prefers it).
function buildEnv(home: string, bin: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    PAWPRINT_TARGET: join(home, ".pi", "agent"),
    CLOUDFLARE_ACCOUNT_ID: "SENTINEL-ACCOUNT-9f8",
    CLOUDFLARE_GATEWAY_ID: "SENTINEL-GATEWAY-2b7",
  };
}
function runSetup(env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [join(REPO, "setup.sh")], { encoding: "utf8", env });
}

function rig() {
  const home = mktmp("pawprint-rt-home-");
  const bin = mktmp("pawprint-rt-bin-");
  const trace = join(bin, "TRACE");
  makeStubs(bin, trace);
  return { home, bin, trace, env: buildEnv(home, bin) };
}

test("setup.sh writes the static pinned-node launcher, idempotently", () => {
  const { home, trace, env } = rig();
  const r1 = runSetup(env);
  assert.equal(r1.status, 0, r1.stderr);
  const launcher = join(home, ".local/bin/pi");
  const first = readFileSync(launcher, "utf8");
  assert.ok(
    first.includes(`N="$HOME/.local/share/mise/installs/node/${PIN}"`),
    "launcher pins the manifest node",
  );
  assert.ok(
    first.includes(
      'exec "$N/bin/node" "$N/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"',
    ),
    "exec line bypasses PATH",
  );
  assert.ok(!first.includes("#!/usr/bin/env node"), "never env-resolved");
  assert.equal(statSync(launcher).mode & 0o777, 0o755);
  const t1 = readFileSync(trace, "utf8");
  assert.ok(t1.includes(`mise install node@${PIN}`), "mise installs the pin");
  assert.ok(
    t1.includes(`pinned-node npm-cli prefix=${join(home, ".local/share/mise/installs/node", PIN)}`),
    "pi installed via npm-cli with the explicit PINNED prefix",
  );

  const r2 = runSetup(env); // overwrite, never self-modify
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(launcher, "utf8"), first, "idempotent: byte-identical on re-run");
});

test("regression: .pi-types resolves the PINNED install, never the foreign npm root", () => {
  const { home, env } = rig(); // stub npm answers root -g with $HOME/foreign-node/...
  const r = runSetup(env);
  assert.equal(r.status, 0, r.stderr);
  const nroot = join(home, ".local/share/mise/installs/node", PIN);
  const link = join(home, ".pi/agent/.pi-types");
  assert.equal(
    readlinkSync(link),
    join(nroot, "lib/node_modules/@earendil-works"),
    "link target is the pinned scope dir (tsconfig consumes .pi-types/pi-coding-agent/...)",
  );
  assert.ok(
    existsSync(join(link, "pi-coding-agent/dist/bundle/cli.js")),
    "link target actually exists (follows through to the pinned bundle)",
  );
  assert.ok(!existsSync(join(home, "foreign-node")), "foreign npm root never materialized");
});

test("regression: pinned node missing and mise can't provide it → setup fails, no launcher", () => {
  const home = mktmp("pawprint-rt-nonode-");
  const bin = mktmp("pawprint-rt-nonode-bin-");
  makeStubsNoNode(bin, join(bin, "TRACE"));
  const r = runSetup(buildEnv(home, bin));
  assert.notEqual(r.status, 0, "setup must fail");
  assert.ok(r.stderr.includes(`pinned node ${PIN} missing`), r.stderr);
  assert.ok(!existsSync(join(home, ".local/bin/pi")), "launcher NOT written");
});

test("regression: pinned npm can't install pi → setup fails, no launcher", () => {
  const home = mktmp("pawprint-rt-noppi-");
  const bin = mktmp("pawprint-rt-nopii-bin-");
  makeStubsNoNode(bin, join(bin, "TRACE"));
  // pinned node present, but running npm-cli.js through it always fails
  const nroot = join(home, ".local/share/mise/installs/node", PIN);
  mkdirSync(join(nroot, "bin"), { recursive: true });
  mkdirSync(join(nroot, "lib/node_modules/npm/bin"), { recursive: true });
  writeFileSync(
    join(nroot, "bin/node"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${PIN}; exit 0; fi\ncase "$1" in */npm-cli.js) exit 1;; esac\n`,
  );
  writeFileSync(join(nroot, "lib/node_modules/npm/bin/npm-cli.js"), "// placeholder\n");
  chmodSync(join(nroot, "bin/node"), 0o755);
  const r = runSetup(buildEnv(home, bin));
  assert.notEqual(r.status, 0, "setup must fail");
  assert.ok(r.stderr.includes("install -g @earendil-works/pi-coding-agent failed"), r.stderr);
  assert.ok(!existsSync(join(home, ".local/bin/pi")), "launcher NOT written");
});

test("regression: decoy node first on PATH cannot hijack the pi install prefix", () => {
  const { home, trace, env } = rig();
  // decoy toolchain: a `node` that, like real npm, would derive the global
  // prefix from its OWN location (process.execPath) if the npm shim ran it
  const decoyRoot = join(home, "decoy-toolchain");
  const decoyBin = join(decoyRoot, "bin");
  mkdirSync(decoyBin, { recursive: true });
  writeFileSync(join(decoyBin, "node"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo v99.0.0; exit 0; fi
case "$1" in
  */npm-cli.js)
    here=$(cd "$(dirname "$0")/.." && pwd)
    echo "decoy-node npm-cli prefix=$here" >> "${trace}"
    pid="$here/lib/node_modules/@earendil-works/pi-coding-agent"
    mkdir -p "$pid/dist/bundle"
    echo "// decoy bundle" > "$pid/dist/bundle/cli.js"
    ;;
esac
`);
  chmodSync(join(decoyBin, "node"), 0o755);
  const r = runSetup({ ...env, PATH: `${decoyBin}:${env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  const nroot = join(home, ".local/share/mise/installs/node", PIN);
  assert.ok(
    existsSync(join(nroot, "lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")),
    "pi bundle landed under the PINNED prefix",
  );
  assert.ok(
    !existsSync(join(decoyRoot, "lib")),
    "nothing installed under the decoy toolchain prefix",
  );
  const t = readFileSync(trace, "utf8");
  assert.ok(t.includes(`pinned-node npm-cli prefix=${nroot}`), "pinned interpreter ran npm-cli");
  assert.ok(!t.includes("decoy-node npm-cli"), "decoy node never ran npm-cli");
  assert.ok(existsSync(join(home, ".local/bin/pi")), "launcher written");
});

test("regression: existing launcher symlink is replaced, never followed", () => {
  const { home, env } = rig();
  const lbin = join(home, ".local/bin");
  mkdirSync(lbin, { recursive: true });
  const victim = join(home, "victim.js");
  writeFileSync(victim, "SENTINEL-VICTIM\n");
  symlinkSync(victim, join(lbin, "pi"));
  const r = runSetup(env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(victim, "utf8"), "SENTINEL-VICTIM\n", "symlink target untouched");
  assert.ok(!lstatSync(join(lbin, "pi")).isSymbolicLink(), "launcher is a regular file");
  assert.ok(readFileSync(join(lbin, "pi"), "utf8").includes("mise/installs/node/"));
});

test("regression: failing foreign PATH npm cannot abort setup before the launcher", () => {
  const home = mktmp("pawprint-rt-legacy-");
  const bin = mktmp("pawprint-rt-legacy-bin-");
  const trace = join(bin, "TRACE");
  // pinned runtime ALREADY present (node + bundle) → no bootstrap install needed
  const nroot = join(home, ".local/share/mise/installs/node", PIN);
  mkdirSync(join(nroot, "bin"), { recursive: true });
  writeFakePinnedNode(join(nroot, "bin/node"), trace);
  const pid = join(nroot, "lib/node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(join(pid, "dist/bundle"), { recursive: true });
  writeFileSync(join(pid, "dist/bundle/cli.js"), "// fake bundle\n");
  writeFileSync(join(pid, "package.json"), '{"engines":{"node":">=22.19.0"}}\n');
  // foreign npm: any `install -g` fails (read-only prefix), traced; root -g works
  writeFileSync(join(bin, "npm"), `#!/bin/sh
echo "npm $@" >> "${trace}"
case " $@ " in
  *" install -g "*) echo FOREIGN_PREFIX_READ_ONLY >&2; exit 9;;
esac
if [ "$1" = "root" ]; then echo "${home}/npmroot"; fi
`);
  chmodSync(join(bin, "npm"), 0o755);
  for (const tool of ["mise", "gh", "agent-browser"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $@" >> "${trace}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  // crucially NO pi on PATH: minimal PATH (jq is /usr/bin/jq); the deleted
  // legacy line would have run the failing npm install and killed setup here
  const env = { ...buildEnv(home, bin), PATH: `${bin}:/usr/bin:/bin` };
  const r = runSetup(env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, ".local/bin/pi")), "launcher written");
  const t = readFileSync(trace, "utf8");
  assert.ok(
    !t.includes("npm install -g @earendil-works/pi-coding-agent"),
    "legacy PATH-npm pi install never attempted",
  );
});

test("regression: inherited PAWPRINT_TARGET cannot redirect the imprint", () => {
  const { home, env } = rig();
  const sentinel = join(mktmp("pawprint-rt-sentinel-"), "live-target");
  process.env.PAWPRINT_TARGET = sentinel; // the leak the old spread allowed
  try {
    const clean = buildEnv(home, env.PATH!.split(":")[0]!);
    assert.equal(clean.PAWPRINT_TARGET, join(home, ".pi", "agent"), "env pins the temp target");
    assert.ok(!Object.keys(clean).some((k) => k.startsWith("PAWPRINT_") && k !== "PAWPRINT_TARGET"));
    const r = runSetup(clean);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    delete process.env.PAWPRINT_TARGET;
  }
  assert.ok(!existsSync(sentinel), "nothing written to the inherited target");
  assert.ok(existsSync(join(home, ".local/bin/pi")), "launcher landed in temp HOME");
});
