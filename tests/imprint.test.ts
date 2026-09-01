// imprint.test.ts — the 10-case imprint matrix, encoded. This suite is the
// regression net for setup.sh / sync-back.sh. Scripts run via bash in
// child_process; assertions are on the filesystem. The 210k-file full-replica
// run stays a manual pre-ship gate; case 2 uses a mini-replica.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
function runSetup(args: string[]) {
  return execFileSync("bash", [join(REPO, "setup.sh"), ...args], { encoding: "utf8" });
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
  const out1 = runSetup(["--target", t]);
  assert.equal((out1.match(/^imprinted:/gm) ?? []).length, printFiles.length);
  for (const f of printFiles) assert.ok(existsSync(join(t, f)), `landed: ${f}`);
  const out2 = runSetup(["--target", t]);
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
  const out = runSetup(["--target", t]);
  assert.equal((out.match(/^ok \(same\)/gm) ?? []).length, printFiles.length);
  assert.deepEqual(manifestDiff(before, manifest(t)), [], "manifest diff EMPTY — nothing touched");
  assert.equal(JSON.parse(readFileSync(join(t, "auth.json"), "utf8")).junk, "SECRET-DECOY");
});

test("3. drifted curated file: .bak-pawprint holds the drift, file restored to print", () => {
  const t = mktmp("pawprint-t3-");
  runSetup(["--target", t]);
  writeFileSync(join(t, "AGENTS.md"), readFileSync(join(t, "AGENTS.md")) + "\nDRIFT-MARKER\n");
  const before = manifest(t);
  const out = runSetup(["--target", t]);
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
  runSetup(["--target", t]);
  writeFileSync(join(t, "settings.json"), readFileSync(join(t, "settings.json")) + "\n");
  const before = manifest(t);
  const out = runSetup(["--target", t, "--dry-run"]);
  assert.ok(out.includes("DRY:"), "dry-run announced its plan");
  assert.deepEqual(manifestDiff(before, manifest(t)), []);
});

test("5. layout exactness: exact agent-relative paths; no pi-agent/ subdir", () => {
  const t = mktmp("pawprint-t5-");
  runSetup(["--target", t]);
  for (const f of printFiles) assert.ok(existsSync(join(t, f)), f);
  assert.ok(!existsSync(join(t, "pi-agent")), "no doubled prefix");
});

test("6. sync-back: never adopts new files; pristine run is empty, exit 0", () => {
  const t = mktmp("pawprint-t6-");
  runSetup(["--target", t]);
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
  runSetup(["--target", t]);
  const copy = mktmp("pawprint-t7repo-");
  cpSync(REPO, copy, { recursive: true });
  execFileSync("git", ["-C", copy, "rm", "-q", "pi-agent/AGENTS.md"]);
  const out = execFileSync("bash", [join(copy, "setup.sh"), "--target", t], { encoding: "utf8" });
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
  const out = execFileSync("bash", [join(REPO, "setup.sh"), "--config-only", "--target", t], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });
  for (const f of printFiles) assert.ok(existsSync(join(t, f)), `landed: ${f}`);
  assert.ok(out.includes("machine machinery: SKIPPED"));
  assert.ok(!existsSync(trace), "no machinery tool was invoked");
});

test("9. exec bits: in repo; imprint preserves modes (cp -a)", () => {
  for (const f of ["setup.sh", "scripts/sync-back.sh"])
    accessSync(join(REPO, f), constants.X_OK);
  const t = mktmp("pawprint-t9-");
  runSetup(["--target", t]);
  // no executable ships in the print; assert modes survive the imprint
  assert.equal(
    statSync(join(t, "AGENTS.md")).mode & 0o777,
    statSync(join(PRINT, "AGENTS.md")).mode & 0o777,
  );
});

test("10. empty target: no auth.json; closing message lists the manual steps", () => {
  const t = mktmp("pawprint-t10-");
  const out = runSetup(["--target", t]);
  assert.ok(!existsSync(join(t, "auth.json")));
  for (const step of ["/login", "/mcp-auth", "/trust"])
    assert.ok(out.includes(step), `closing message mentions ${step}`);
});
