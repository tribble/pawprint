// imprint.test.ts — the 10-case imprint matrix, encoded. This suite is the
// regression net for setup.sh / sync-back.sh. Scripts run via bash in
// child_process; assertions are on the filesystem. The 210k-file full-replica
// run stays a manual pre-ship gate; case 2 uses a mini-replica.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  cpSync, rmSync, chmodSync, accessSync, constants, readdirSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const REPO = join(import.meta.dirname, "..");
const PRINT = join(REPO, "pi-agent");

const printFiles: string[] = execFileSync("git", ["-C", REPO, "ls-files", "pi-agent/"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .map((f) => f.replace(/^pi-agent\//, ""));

function mktmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}
// setup.sh wires core.hooksPath into the checkout it runs from; GIT_DIR sends
// that write to a scratch repo so tests never touch this checkout's .git/config.
const GIT_DIR = mktmp("pawprint-gitdir-");
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
      if (statSync(p).isDirectory()) walk(p);
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

test("1. empty target: all print files land; re-run is skip-identical, zero .bak", () => {
  const t = mktmp("pawprint-t1-");
  const out1 = runSetup(["--all", "--target", t]);
  assert.equal((out1.match(/^imprinted:/gm) ?? []).length, printFiles.length);
  for (const f of printFiles) assert.ok(existsSync(join(t, f)), `landed: ${f}`);
  const out2 = runSetup(["--all", "--target", t]);
  assert.equal((out2.match(/^ok \(same\)/gm) ?? []).length, printFiles.length);
  assert.ok(!out2.includes("imprinted:"));
  assert.deepEqual(
    readdirSync(t, { recursive: true }).filter((f) => String(f).includes(".bak-pawprint-")),
    [],
  );
});

test("2. mini-replica: imprint is a pure no-op; auth.json + decoys byte-identical", () => {
  const t = mktmp("pawprint-t2-");
  for (const f of printFiles) {
    mkdirSync(join(t, f, ".."), { recursive: true });
    cpSync(join(PRINT, f), join(t, f));
  }
  // decoys: the sensitive/unmanaged stuff a real agent dir carries
  writeFileSync(join(t, "auth.json"), JSON.stringify({ junk: "SECRET-DECOY" }));
  mkdirSync(join(t, "sessions", "2026"), { recursive: true });
  writeFileSync(join(t, "sessions", "2026", "s.jsonl"), "{}");
  mkdirSync(join(t, ".git", "objects"), { recursive: true });
  writeFileSync(join(t, ".git", "HEAD"), "ref: refs/heads/main");
  const before = manifest(t);
  const out = runSetup(["--all", "--target", t]);
  assert.equal((out.match(/^ok \(same\)/gm) ?? []).length, printFiles.length);
  assert.deepEqual(manifestDiff(before, manifest(t)), [], "manifest diff EMPTY — nothing touched");
  assert.equal(JSON.parse(readFileSync(join(t, "auth.json"), "utf8")).junk, "SECRET-DECOY");
});

test("3. drifted curated file: .bak-pawprint holds the drift, file restored to print", () => {
  const t = mktmp("pawprint-t3-");
  runSetup(["--all", "--target", t]);
  writeFileSync(join(t, "AGENTS.md"), readFileSync(join(t, "AGENTS.md")) + "\nDRIFT-MARKER\n");
  const before = manifest(t);
  const out = runSetup(["--all", "--target", t]);
  assert.ok(out.includes("backed up:") && out.includes(`imprinted:     ${join(t, "AGENTS.md")}`));
  const bak = readdirSync(t).find((f) => f.startsWith("AGENTS.md.bak-pawprint-"));
  assert.ok(bak, "backup created");
  assert.ok(readFileSync(join(t, bak!), "utf8").includes("DRIFT-MARKER"), "backup has the drift");
  assert.ok(!readFileSync(join(t, "AGENTS.md"), "utf8").includes("DRIFT-MARKER"), "restored to print");
  assert.deepEqual(
    manifestDiff(before, manifest(t)),
    ["AGENTS.md", bak!].sort(),
    "only the drifted path + its backup changed",
  );
});

test("4. --dry-run on drifted target: zero writes (manifest diff fully empty)", () => {
  const t = mktmp("pawprint-t4-");
  runSetup(["--all", "--target", t]);
  writeFileSync(join(t, "settings.json"), readFileSync(join(t, "settings.json")) + "\n");
  const before = manifest(t);
  const out = runSetup(["--all", "--target", t, "--dry-run"]);
  assert.ok(out.includes("DRY:"), "dry-run announced its plan");
  assert.deepEqual(manifestDiff(before, manifest(t)), []);
});

test("5. layout exactness: exact agent-relative paths; no pi-agent/ subdir", () => {
  const t = mktmp("pawprint-t5-");
  runSetup(["--all", "--target", t]);
  for (const f of printFiles) assert.ok(existsSync(join(t, f)), f);
  assert.ok(!existsSync(join(t, "pi-agent")), "no doubled prefix");
});

test("6. sync-back: never adopts new files; pristine run is empty, exit 0", () => {
  const t = mktmp("pawprint-t6-");
  runSetup(["--all", "--target", t]);
  mkdirSync(join(t, "extensions"), { recursive: true });
  writeFileSync(join(t, "extensions", "evil.ts"), "export const evil = true\n");
  const env = { ...process.env, PAWPRINT_TARGET: t };
  // robust to a dirty worktree: assert sync-back ADDS nothing to the diff
  const statBefore = execFileSync("git", ["-C", REPO, "diff", "--stat"], { encoding: "utf8" });
  const out = execFileSync("bash", [join(REPO, "scripts", "sync-back.sh")], { encoding: "utf8", env });
  assert.ok(!existsSync(join(PRINT, "extensions", "evil.ts")), "evil.ts NOT adopted");
  assert.equal((out.match(/^synced:/gm) ?? []).length, 0, "pristine: nothing synced");
  const statAfter = execFileSync("git", ["-C", REPO, "diff", "--stat"], { encoding: "utf8" });
  assert.equal(statAfter, statBefore, "sync-back introduced no repo changes");
});

test("7. never destructive: print file removed from a repo copy stays in target", () => {
  const t = mktmp("pawprint-t7-");
  runSetup(["--all", "--target", t]);
  const copy = mktmp("pawprint-t7repo-");
  // Skip .git: in a linked worktree it is a pointer FILE, and any git command in the copy would
  // mutate the real worktree's index. setup.sh reads manifest.json and only touches git when the
  // copy has a .git (hooksPath), so plain rm suffices.
  cpSync(REPO, copy, { recursive: true, filter: (src) => !src.endsWith("/.git") });
  rmSync(join(copy, "pi-agent", "AGENTS.md"));
  // manifest.json is the source of truth — removal means out of the manifest too
  execFileSync("sh", ["-c", "jq 'del(.files[] | select(. == \"AGENTS.md\"))' manifest.json > m.json && mv m.json manifest.json"], { cwd: copy });
  const out = execFileSync("bash", [join(copy, "setup.sh"), "--all", "--target", t], { encoding: "utf8" });
  assert.ok(!out.includes("AGENTS.md"), "removed-from-print file not mentioned");
  assert.ok(existsSync(join(t, "AGENTS.md")), "still in the target");
  rmSync(copy, { recursive: true, force: true });
});

test("8. --config-only on nonexistent target: created, imprinted, machinery never invoked", () => {
  const t = join(mktmp("pawprint-t8-"), "does-not-exist-yet");
  // PATH shim: any machinery invocation of these tools leaves a trace file
  const bin = mktmp("pawprint-t8bin-");
  const trace = join(bin, "TRACE");
  for (const tool of ["pi", "npm", "mise", "gh", "agent-browser"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> "${trace}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const out = execFileSync("bash", [join(REPO, "setup.sh"), "--all", "--config-only", "--target", t], {
    encoding: "utf8",
    env: { ...SETUP_ENV, PATH: `${bin}:/usr/bin:/bin` },
  });
  for (const f of printFiles) assert.ok(existsSync(join(t, f)), `landed: ${f}`);
  assert.ok(out.includes("machine machinery: SKIPPED"));
  assert.ok(!existsSync(trace), "no machinery tool was invoked");
});

test("9. exec bits: in repo; imprint preserves modes (cp -a)", () => {
  for (const f of ["setup.sh", "scripts/sync-back.sh"])
    accessSync(join(REPO, f), constants.X_OK);
  const t = mktmp("pawprint-t9-");
  runSetup(["--all", "--target", t]);
  // no executable ships in the print; assert modes survive the imprint
  assert.equal(
    statSync(join(t, "AGENTS.md")).mode & 0o777,
    statSync(join(PRINT, "AGENTS.md")).mode & 0o777,
  );
});

test("10. empty target: no auth.json; closing message lists the manual steps", () => {
  const t = mktmp("pawprint-t10-");
  const out = runSetup(["--all", "--target", t]);
  assert.ok(!existsSync(join(t, "auth.json")));
  for (const step of ["/login", "/mcp-auth", "/trust"])
    assert.ok(out.includes(step), `closing message mentions ${step}`);
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
  const t = mktmp("pawprint-t12-");
  const bad = spawnSetup(["--target", t, "--only", "extensions/btw.ts", "nope/x.ts"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /nope\/x\.ts/);
  assert.deepEqual([...manifest(t).keys()], [], "unknown path: nothing copied");
  // an empty arg is not a path: raw, it once selected the target dir itself and cp -a'd it into its own backup
  writeFileSync(join(t, "auth.json"), "SENTINEL");
  const empty = spawnSetup(["--target", t, "--only", "extensions/btw.ts", ""]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /not in manifest\.json files\[\]: ""/);
  assert.deepEqual([...manifest(t).keys()], ["auth.json"], "empty path: nothing copied, nothing backed up");
  rmSync(join(t, "auth.json"));

  mkdirSync(join(t, "extensions"), { recursive: true });
  writeFileSync(join(t, "extensions", "btw.ts"), "// mine\n");
  const dry = runSetup(["--dry-run", "--target", t, "--only", "extensions/btw.ts", "extensions/pr-footer.ts"]);
  assert.equal((dry.match(/^DRY: cp -a /gm) ?? []).length, 3, "plan: one backup + two copies");
  assert.deepEqual([...manifest(t).keys()], ["extensions/btw.ts"], "dry-run wrote nothing");

  const r = spawnSetup(["--target", t, "--only", "extensions/btw.ts", "extensions/pr-footer.ts"]);
  assert.equal(r.status, 0, r.stderr);
  const got = [...manifest(t).keys()].sort();
  const bak = got.find((f) => f.startsWith("extensions/btw.ts.bak-pawprint-"));
  assert.ok(bak, "differing file was backed up");
  assert.deepEqual(got, ["extensions/btw.ts", bak!, "extensions/pr-footer.ts"].sort(), "exactly the two files + the backup");
  assert.equal(readFileSync(join(t, bak!), "utf8"), "// mine\n");
  assert.equal(readFileSync(join(t, "extensions", "btw.ts"), "utf8"), readFileSync(join(PRINT, "extensions", "btw.ts"), "utf8"));
  assert.equal(r.stderr, "", "non-personal files: no warning");
  assert.ok(!r.stdout.includes("Manual steps remain") && r.stdout.includes("machine machinery: SKIPPED"));

  const p = spawnSetup(["--target", t, "--only", "settings.json"]);
  assert.equal(p.status, 0);
  assert.equal(p.stderr.trim(), "settings.json encodes tribble's own choices — read it before you keep it");
  assert.ok(existsSync(join(t, "settings.json")), "personal file still copied");
});

test("13. no selector: bare setup.sh refuses (exit 2, pointer on stderr, target untouched); --all + --only is refused too", () => {
  const t = mktmp("pawprint-t13-");
  writeFileSync(join(t, "auth.json"), "SENTINEL");
  const before = manifest(t);
  for (const args of [["--target", t], ["--dry-run", "--config-only", "--target", t]]) {
    const r = spawnSetup(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    for (const line of ["one person's pi config print", "--list", "--only <path>", "--all"])
      assert.ok(r.stderr.includes(line), `pointer mentions ${line}`);
  }
  const both = spawnSetup(["--target", t, "--all", "--only", "extensions/btw.ts"]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /exclusive/);
  assert.deepEqual(manifestDiff(before, manifest(t)), [], "nothing written by any refused run");
});
