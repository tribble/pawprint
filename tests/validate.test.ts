// validate.sh: the read-only machine-vs-print audit. Fresh imprint → green;
// one drifted file → names exactly that file; missing env var → fails naming it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync,
  cpSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const PIN: string = JSON.parse(readFileSync(join(REPO, "manifest.json"), "utf8")).runtime.node;
const ENV_OK = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: "SENTINEL-ACCOUNT-9f8",
  CLOUDFLARE_GATEWAY_ID: "SENTINEL-GATEWAY-2b7",
};

function mktmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}
// Real semver for the engines fixture: validate.sh requires the pinned pi's
// bundled node_modules/semver, so the fixture must carry the real thing —
// npm always bundles one; copy it.
const NPM_ROOT = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const SEMVER_SRC = join(NPM_ROOT, "npm/node_modules/semver");
assert.ok(existsSync(SEMVER_SRC), `npm's bundled semver not found at ${SEMVER_SRC}`);

// Fabricate a pinned runtime under a temp HOME: a node that reports the
// pinned version but otherwise execs the real test-runner node (validate.sh
// runs the engines read + semver check THROUGH the pinned interpreter, so a
// fake that can't evaluate JS would hide exactly that wiring), pi "installed"
// under it (configurable engines range / bundle / real bundled semver), and
// the generated launcher.
function fakeHome(
  opts: { nodeReports?: string; range?: string; semver?: boolean; bundle?: boolean } = {},
) {
  const { nodeReports = PIN, range = ">=22.19.0", semver = true, bundle = true } = opts;
  const home = mktmp("pawprint-home-");
  const nroot = join(home, ".local/share/mise/installs/node", PIN);
  mkdirSync(join(nroot, "bin"), { recursive: true });
  writeFileSync(
    join(nroot, "bin/node"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo v${nodeReports}; exit 0; fi
exec "${process.execPath}" "$@"
`,
  );
  chmodSync(join(nroot, "bin/node"), 0o755);
  const pidir = join(nroot, "lib/node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(pidir, { recursive: true });
  writeFileSync(join(pidir, "package.json"), JSON.stringify({ engines: { node: range } }));
  if (bundle) {
    mkdirSync(join(pidir, "dist/bundle"), { recursive: true });
    writeFileSync(join(pidir, "dist/bundle/cli.js"), "// fake bundle\n");
  }
  if (semver) cpSync(SEMVER_SRC, join(pidir, "node_modules/semver"), { recursive: true });
  const lbin = join(home, ".local/bin");
  mkdirSync(lbin, { recursive: true });
  writeFileSync(
    join(lbin, "pi"),
    `#!/bin/sh
# pawprint: pi runs on its pinned node, never the cwd's toolchain (direnv/flake/.nvmrc)
N="$HOME/.local/share/mise/installs/node/${PIN}"
exec "$N/bin/node" "$N/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"
`,
  );
  chmodSync(join(lbin, "pi"), 0o755);
  return home;
}
// validate.sh reads $HOME for the runtime checks; ~/.local/bin must lead PATH.
function envFor(home: string, pathPrefix = ""): NodeJS.ProcessEnv {
  return { ...ENV_OK, HOME: home, PATH: `${pathPrefix}${join(home, ".local/bin")}:${process.env.PATH}` };
}

function imprint(t: string) {
  execFileSync("bash", [join(REPO, "setup.sh"), "--target", t], { encoding: "utf8" });
}
function validate(t: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [join(REPO, "scripts", "validate.sh"), "--target", t], {
    encoding: "utf8",
    env,
  });
}

test("fresh imprint → validate green, exit 0", () => {
  const t = mktmp("pawprint-v1-");
  imprint(t);
  const r = validate(t, envFor(fakeHome()));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes("VALID: machine matches the print"));
  assert.ok(!r.stdout.includes("drift:") && !r.stdout.includes("missing:"));
  assert.ok(r.stdout.includes("tool ok:"), "tools audited");
});

test("one drifted file → validate fails naming exactly that file", () => {
  const t = mktmp("pawprint-v2-");
  imprint(t);
  writeFileSync(join(t, "settings.json"), readFileSync(join(t, "settings.json")) + "\n");
  const r = validate(t, envFor(fakeHome()));
  assert.equal(r.status, 1);
  const drift = r.stdout.split("\n").filter((l) => l.startsWith("drift:"));
  assert.deepEqual(drift, ["drift:         settings.json"]);
  assert.ok(!r.stdout.includes("missing:"));
});

test("missing managed file → reported as missing, exit 1", () => {
  const t = mktmp("pawprint-v3-");
  imprint(t);
  execFileSync("rm", [join(t, "mise.toml")]);
  const r = validate(t, envFor(fakeHome()));
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("missing:       mise.toml"));
});

test("missing env var → validate fails naming it (presence, never values)", () => {
  const t = mktmp("pawprint-v4-");
  imprint(t);
  const env: Record<string, string | undefined> = envFor(fakeHome());
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const r = validate(t, env);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("env MISSING:   CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(!r.stdout.includes("SENTINEL-GATEWAY-2b7"), "values never printed");
});

test("pinned node reports wrong version → runtime FAIL, exit 1", () => {
  const t = mktmp("pawprint-v5-");
  imprint(t);
  const r = validate(t, envFor(fakeHome({ nodeReports: "99.0.0" })));
  assert.equal(r.status, 1);
  assert.ok(
    r.stdout.includes(`runtime FAIL:  pinned node reports v99.0.0, want v${PIN}`),
    r.stdout,
  );
  assert.ok(!r.stdout.includes("drift:") && !r.stdout.includes("missing:"), "only runtime fails");
});

test("mise node dir preceding ~/.local/bin on PATH → runtime FAIL, exit 1", () => {
  const t = mktmp("pawprint-v6-");
  imprint(t);
  const home = fakeHome();
  // the live-machine bug shape: a mise node bin dir (carrying its own pi) first
  const miseBin = join(home, ".local/share/mise/installs/node/24/bin");
  mkdirSync(miseBin, { recursive: true });
  writeFileSync(join(miseBin, "pi"), "#!/bin/sh\n");
  chmodSync(join(miseBin, "pi"), 0o755);
  const r = validate(t, envFor(home, `${miseBin}:`));
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("a mise node dir precedes"), r.stdout);
  assert.ok(r.stdout.includes(`command -v pi -> ${join(miseBin, "pi")}`), r.stdout);
});

test("regression: non-executable launcher → runtime FAIL (command -v alone is not proof)", () => {
  const t = mktmp("pawprint-v7-");
  imprint(t);
  const home = fakeHome();
  chmodSync(join(home, ".local/bin/pi"), 0o644);
  const r = validate(t, envFor(home));
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(`runtime FAIL:  ${join(home, ".local/bin/pi")} not executable`), r.stdout);
});

test("regression: engines range with upper bound excludes the pin → runtime FAIL", () => {
  const t = mktmp("pawprint-v8-");
  imprint(t);
  const r = validate(t, envFor(fakeHome({ range: ">=22.19.0 <24.0.0" })));
  assert.equal(r.status, 1);
  assert.ok(
    r.stdout.includes(`runtime FAIL:  node ${PIN} outside pi engines.node range ">=22.19.0 <24.0.0"`),
    r.stdout,
  );
});

test("regression: engines OR-range including the pin → validate green", () => {
  const t = mktmp("pawprint-v9-");
  imprint(t);
  const r = validate(t, envFor(fakeHome({ range: ">=26.0.0 || >=24.0.0" })));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(
    r.stdout.includes(`runtime ok:    pi engines.node (>=26.0.0 || >=24.0.0) accepts node ${PIN}`),
    r.stdout,
  );
});

test("regression: bundled semver missing → FAIL 'cannot evaluate', never a silent pass", () => {
  const t = mktmp("pawprint-v10-");
  imprint(t);
  const r = validate(t, envFor(fakeHome({ semver: false })));
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('runtime FAIL:  cannot evaluate engines range ">=22.19.0"'), r.stdout);
});

test("regression: malformed package.json → FAIL 'cannot read engines', exit 1", () => {
  const t = mktmp("pawprint-v12-");
  imprint(t);
  const home = fakeHome();
  writeFileSync(
    join(home, ".local/share/mise/installs/node", PIN,
      "lib/node_modules/@earendil-works/pi-coding-agent/package.json"),
    "{ not json",
  );
  const r = validate(t, envFor(home));
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("runtime FAIL:  cannot read engines from"), r.stdout);
  assert.ok(!r.stdout.includes("pi sets no engines.node range"), "never a silent pass");
});

test("regression: launcher keeping the pinned N= but exec'ing PATH node → FAIL drifted", () => {
  const t = mktmp("pawprint-v14-");
  imprint(t);
  const home = fakeHome();
  const launcher = join(home, ".local/bin/pi");
  // pinned path substring retained, but the exec line resolves node from PATH —
  // the substring grep passed this; the whole-file compare must not
  writeFileSync(
    launcher,
    `#!/bin/sh
# pawprint: pi runs on its pinned node, never the cwd's toolchain (direnv/flake/.nvmrc)
N="$HOME/.local/share/mise/installs/node/${PIN}"
exec node "$N/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"
`,
  );
  chmodSync(launcher, 0o755);
  const r = validate(t, envFor(home));
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("runtime FAIL:  launcher content drifted"), r.stdout);
});

test("regression: launcher with an extra trailing blank line → FAIL drifted (byte-exact)", () => {
  const t = mktmp("pawprint-v16-");
  imprint(t);
  const home = fakeHome();
  const launcher = join(home, ".local/bin/pi");
  writeFileSync(launcher, readFileSync(launcher, "utf8") + "\n"); // mode preserved
  const r = validate(t, envFor(home));
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("runtime FAIL:  launcher content drifted"), r.stdout);
});

test("regression: validate.sh restores glob state (set -f must not leak)", () => {
  const t = mktmp("pawprint-v17-");
  imprint(t);
  const home = fakeHome();
  const out = join(home, "probe.out");
  // Source the script in the probe shell (exit shadowed so we survive its
  // final `exit`) with the REAL script path as $0 — a dummy $0 makes the
  // script's `cd "$(dirname "$0")/.."` land outside the repo, manifest.json
  // is unreadable, the runtime section is skipped, and the test passes
  // vacuously. Assert the PATH walk actually ran before trusting the flags.
  const probe = `exit() { return 0; }
. "$1" --target "$2" > "$3" 2>&1
grep -q "leads mise node dirs on PATH" "$3" || { echo RUNTIME_SECTION_NOT_REACHED; exit 2; }
case $- in *f*) echo GLOB_OFF;; *) echo GLOB_ON;; esac`;
  const v = join(REPO, "scripts", "validate.sh");
  const r = spawnSync("bash", ["-c", probe, v, v, t, out], {
    encoding: "utf8",
    env: envFor(home),
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.trim().endsWith("GLOB_ON"), `glob state leaked: ${r.stdout}${r.stderr}`);
});

test("regression: launcher target bundle missing under pinned node → FAIL, exit 1", () => {
  const t = mktmp("pawprint-v13-");
  imprint(t);
  const r = validate(t, envFor(fakeHome({ bundle: false })));
  assert.equal(r.status, 1);
  assert.ok(
    r.stdout.includes("runtime FAIL:  pi bundle missing under pinned node:") &&
      r.stdout.includes("dist/bundle/cli.js"),
    r.stdout,
  );
});

test("regression: $lbin-old before a mise dir must not hide it (whole-entry PATH walk)", () => {
  const t = mktmp("pawprint-v11-");
  imprint(t);
  const home = fakeHome();
  const lbin = join(home, ".local/bin");
  const miseBin = join(home, ".local/share/mise/installs/node/24/bin");
  mkdirSync(miseBin, { recursive: true });
  writeFileSync(join(miseBin, "pi"), "#!/bin/sh\n");
  chmodSync(join(miseBin, "pi"), 0o755);
  // substring matching sees ":$lbin" inside "$lbin-old:" and stops — the bug
  const r = validate(t, envFor(home, `${lbin}-old:${miseBin}:`));
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("a mise node dir precedes"), r.stdout);
});
