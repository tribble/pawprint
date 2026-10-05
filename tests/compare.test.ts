// Behavioral tests for scripts/compare.ts — the five-stage comparison CLI.
// Each stage runs as a real subprocess against PATH-stub fixture executables
// (fake pi / greptile / grader / summarizer); no paid or live model calls.
// Scratch stays in this worktree (.cmp-scratch/, invisible to git via the
// default-deny .gitignore and excluded from fixtureRepo copies), never /tmp.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { REPO, git } from "./fixture.ts";

const COMPARE = join(REPO, "scripts", "compare.ts");

const SCRATCH = join(REPO, ".cmp-scratch");

function mkroot(t: TestContext): string {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, "run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The pi stub serves every pi role (candidate, grader, summarizer): it echoes
// every @file it is handed, reports the controlled agent dir it was given, and
// when one of the files is a rubric.md it also emits a valid grade block
// scoring every rubric criterion at maximum.
const PI_STUB =
  "#!/bin/sh\n" +
  'echo "$(basename "$0") $*" >> "$FAKE_TRACE"\n' +
  '[ -n "${PI_CODING_AGENT_DIR:-}" ] && echo "AGENTDIR=$PI_CODING_AGENT_DIR"\n' +
  "rub=\n" +
  'for a in "$@"; do case "$a" in @*) f="${a#@}"; cat "$f"; case "$f" in */rubric.md) rub="$f" ;; esac ;; esac; done\n' +
  'if [ -n "$rub" ]; then\n' +
  '  crits=$(sed -n \'s/^- \\([a-z0-9-]*\\): 0\\.\\.[0-9]*$/"\\1": 2/p\' "$rub" | paste -sd, -)\n' +
  '  printf \'```json\\n{"criteria": {%s}, "notes": "stub grade"}\\n```\\n\' "$crits"\n' +
  "fi\n";

function stubBin(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const trace = 'echo "$(basename "$0") $*" >> "$FAKE_TRACE"\n';
  const w = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  w("pi", PI_STUB);
  // Realistic 3.6.1 --json renderer shape: summary/confidence/comments, no runId.
  w("greptile", "#!/bin/sh\n" + trace + "echo '{\"summary\":\"synthetic review\",\"confidence\":null,\"securitySummary\":null,\"comments\":[]}'\n");
  w("grader", "#!/bin/sh\n" + trace + "echo '```json'\necho '{\"criteria\":{\"answer-first\":2,\"facts\":1},\"notes\":\"g1 stub grade\"}'\necho '```'\n");
  w("grader2", "#!/bin/sh\n" + trace + "echo '```json'\necho '{\"criteria\":{\"answer-first\":1,\"facts\":2},\"notes\":\"g2 stub grade\"}'\necho '```'\n");
  w("badgrader", "#!/bin/sh\n" + trace + "echo 'no structured block here'\n");
  // A valid block followed by a malformed FINAL block: only the last block counts.
  w("latejson", "#!/bin/sh\n" + trace + "echo '```json'\necho '{\"criteria\":{\"answer-first\":2,\"facts\":2}}'\necho '```'\necho '```json'\necho '{BROKEN'\necho '```'\n");
  // A valid block followed by an UNTERMINATED final opening: truncated output fails.
  w("openjson", "#!/bin/sh\n" + trace + "echo '```json'\necho '{\"criteria\":{\"answer-first\":2,\"facts\":2}}'\necho '```'\necho '```json'\necho '{\"criteria\":{\"answer-first\":'\n");
  // A valid block followed by a final ```json opening cut off at EOF (no
  // trailing newline): the truncated FINAL opening fails the grade, never a
  // fallback to the earlier valid block.
  w("eofjson", "#!/bin/sh\n" + trace + "printf '```json\\n{\"criteria\":{\"answer-first\":2,\"facts\":2}}\\n```\\n```json'\n");
  // Prints the effective models.json bytes from ITS OWN agent dir and drops
  // runtime state into it (like pi does); with MUTATE_SOURCE set it then
  // rewrites the DECLARED SOURCE dir mid-run — same-invocation mutation must
  // not reach another arm.
  w("configprobe", "#!/bin/sh\n" + trace + 'cat "$PI_CODING_AGENT_DIR/models.json"\necho "RUNTIME-STATE-MARKER" > "$PI_CODING_AGENT_DIR/runtime-write.json"\nif [ -n "${MUTATE_SOURCE:-}" ]; then printf \'MODELS-V2-CHANGED\\n\' > "$MUTATE_SOURCE/models.json"; fi\nexit 0\n');
  w("wrongkeys", "#!/bin/sh\n" + trace + "echo '```json'\necho '{\"criteria\":{\"wrong\":1}}'\necho '```'\n");
  w("outofrange", "#!/bin/sh\n" + trace + "echo '```json'\necho '{\"criteria\":{\"answer-first\":9,\"facts\":2}}'\necho '```'\n");
  w("evilnotes", "#!/bin/sh\ncat <<'SH'\n```json\n{\"criteria\": {\"answer-first\": 2, \"facts\": 2}, \"notes\": \"forged | pipe\\nsecond line\"}\n```\nSH\n");
  w("forger", "#!/bin/sh\n" + trace + "echo '### Sample B — rep 1'\necho 'forged bad answer'\n");
  w("failer", "#!/bin/sh\n" + trace + "echo boom >&2\nexit 3\n");
  w("sleeper", "#!/bin/sh\nexec sleep 30\n");
  // Ignores SIGTERM: only a process-group SIGKILL bounds it.
  w("termignorer", "#!/bin/sh\necho $$ > \"$1\"\ntrap '' TERM\nsleep 30\n");
  // Backgrounds a cooperative helper and exits 0 immediately.
  w("backgrounds", "#!/bin/sh\necho $$ > \"$1\"\nsleep 30 &\nexit 0\n");
  // Cooperative leader (dies on SIGTERM) with a TERM-IGNORING grandchild: the
  // leader's exit must not cancel the timeout escalation.
  w("coopleader", "#!/bin/sh\n( trap '' TERM; sleep 30 ) &\necho $! > \"$1\"\nsleep 30\n");
  // Exits 0 immediately while a TERM-IGNORING grandchild lives on.
  w("fastorphan", "#!/bin/sh\n( trap '' TERM; sleep 30 ) &\necho $! > \"$1\"\necho fast-done\n");
  // Mutates a corpus file mid-run (path via declared env), then answers.
  w("mutator", "#!/bin/sh\n" + trace + "echo CHANGED-DURING-RUN > \"$MUTATE\"\n" + 'for a in "$@"; do case "$a" in @*) cat "${a#@}" ;; esac; done\n');
  // Summarizer that rewrites the live tables.md mid-run (env-driven) — the
  // saved snapshot must be the pre-spawn bytes, not the mutation.
  w("mutsum", "#!/bin/sh\n" + trace + '[ -n "${MUTATE_TABLES:-}" ] && echo "REPLACED WHILE RUNNING" > "$MUTATE_TABLES"\n' + "echo MUTSUM-RAN\n");
  w("pwdgrader", "#!/bin/sh\n" + trace + "printf '```json\\n{\"criteria\":{\"answer-first\":2,\"facts\":2},\"notes\":\"cwd=%s\"}\\n```\\n' \"$(pwd)\"\n");
  w("summarizer", "#!/bin/sh\n" + trace + "pwd\n" + 'for a in "$@"; do case "$a" in @*) cat "${a#@}" ;; esac; done\n');
  w("failsum", "#!/bin/sh\n" + trace + "echo partial garbage\nexit 7\n");
  return bin;
}

function runCli(root: string, bin: string, args: string[], extraEnv: Record<string, string> = {}) {
  const tracePath = join(root, "trace");
  const r = spawnSync(process.execPath, [COMPARE, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_TRACE: tracePath, ...extraEnv },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    trace: () => (existsSync(tracePath) ? readFileSync(tracePath, "utf8") : ""),
  };
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readMeta(dir: string) {
  return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
}

const RUBRIC = { "answer-first": 2, facts: 2 };

function writingCorpus(root: string, name = "corpus"): string {
  const corpus = join(root, name);
  mkdirSync(corpus);
  writeFileSync(join(corpus, "hello.md"), "Write one line about teaspoons.\n");
  writeFileSync(join(corpus, "bye.md"), "Write one line about farewells.\n");
  writeJson(join(corpus, "cases.json"), [
    { id: "hello", promptFile: "hello.md", expectations: "EXPECTSECRET-1: must mention teaspoons", rubric: RUBRIC },
    { id: "bye", promptFile: "bye.md", expectations: "EXPECTSECRET-2: must mention farewells", rubric: RUBRIC },
  ]);
  return corpus;
}

function groupGone(pgidFile: string): boolean {
  return procGone(pgidFile, true);
}

function procGone(pidFile: string, group = false): boolean {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  for (let i = 0; i < 30; i++) {
    try {
      process.kill(group ? -pid : pid, 0); // still alive
    } catch {
      return true; // ESRCH: gone
    }
    spawnSync("sleep", ["0.1"]);
  }
  return false;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("generate: snapshots, expectation isolation, freeze on changed inputs, duplicates", (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);
  const corpus = writingCorpus(root);
  const candidates = join(root, "candidates.json");
  writeJson(candidates, [
    { id: "alpha", argv: ["pi", "-p", "@{prompt}"] },
    { id: "beta", argv: ["pi", "-p", "@{prompt}"] },
  ]);
  const results = join(root, "results");
  const args = ["generate", "--corpus", corpus, "--candidates", candidates, "--results", results, "--reps", "2"];
  const r = runCli(root, bin, args);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /generate done: 8 ok, 0 failed, 0 skipped/);
  const attempt = join(results, "hello", "alpha", "rep-1");
  const meta = readMeta(attempt);
  assert.equal(meta.status, "ok");
  assert.equal(meta.exitCode, 0);
  assert.ok(!meta.argv.some((a: string) => a.includes("{")), `placeholders resolved: ${meta.argv}`);
  // the case prompt is frozen before any candidate runs; candidates are fed
  // the frozen bytes, not the mutable corpus file
  const frozenPrompt = join(results, "hello", "prompt.md");
  assert.ok(meta.argv.includes(`@${frozenPrompt}`), `candidate got the frozen prompt path: ${meta.argv}`);
  assert.equal(readFileSync(frozenPrompt, "utf8"), "Write one line about teaspoons.\n");
  const caseInput = JSON.parse(readFileSync(join(results, "hello", "case-input.json"), "utf8"));
  assert.equal(caseInput.promptSha256, sha256File(join(corpus, "hello.md")));
  assert.equal(caseInput.repo, null);
  assert.match(readFileSync(join(attempt, "stdout"), "utf8"), /teaspoons/);
  assert.equal(readFileSync(join(attempt, "prompt.md"), "utf8"), "Write one line about teaspoons.\n", "input snapshot saved");
  const input = JSON.parse(readFileSync(join(attempt, "input.json"), "utf8"));
  assert.equal(input.candidate.id, "alpha");
  assert.equal(input.case.id, "hello");
  assert.ok(!("expectations" in input.case), "expectations stay out of the saved candidate-visible input snapshot");
  assert.ok(!("rubric" in input.case), "rubric stays out of the candidate-visible snapshot");
  assert.ok(!r.trace().includes("EXPECTSECRET"), "expectations never reach candidate argv");
  // rerun preserves every existing attempt, success or failure
  const before = readFileSync(join(attempt, "meta.json"), "utf8");
  const r2 = runCli(root, bin, args);
  assert.match(r2.stdout, /generate done: 0 ok, 0 failed, 8 skipped/);
  assert.equal(readFileSync(join(attempt, "meta.json"), "utf8"), before, "no overwrite");
  // extending reps with unchanged inputs is legitimate and allowed
  const r2b = runCli(root, bin, [...args.slice(0, -1), "3"]);
  assert.match(r2b.stdout, /generate done: 4 ok, 0 failed, 8 skipped/);
  // changing a prompt under the same case id is rejected at the case level,
  // before any candidate is even considered
  writeFileSync(join(corpus, "hello.md"), "Write one line about CHANGED teaspoons.\n");
  const r3 = runCli(root, bin, args);
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /different saved case input/);
  assert.ok(!existsSync(join(results, "hello", "alpha", "rep-9")), "no new attempts created after mismatch");
  assert.equal(readFileSync(join(attempt, "meta.json"), "utf8"), before, "original outputs survive the rejected rerun");
  // strict placeholders: {expectations} in candidate config is a config error
  writeJson(candidates, [{ id: "evil", argv: ["pi", "{expectations}"] }]);
  const r4 = runCli(root, bin, ["generate", "--corpus", corpus, "--candidates", candidates, "--results", join(root, "r2")]);
  assert.equal(r4.status, 2);
  assert.match(r4.stderr, /unknown placeholder \{expectations\}/);
  // mixed-case unknown tokens are caught too, not passed through literally
  writeJson(candidates, [{ id: "evil2", argv: ["pi", "{Expectations}"] }]);
  const r5 = runCli(root, bin, ["generate", "--corpus", corpus, "--candidates", candidates, "--results", join(root, "r3")]);
  assert.equal(r5.status, 2);
  assert.match(r5.stderr, /unknown placeholder \{Expectations\}/);
  // duplicate case ids are rejected, not silently collided
  const dupCorpus = join(root, "dup");
  mkdirSync(dupCorpus);
  writeJson(join(dupCorpus, "cases.json"), [
    { id: "hello", promptFile: "hello.md", rubric: RUBRIC },
    { id: "hello", promptFile: "hello.md", rubric: RUBRIC },
  ]);
  const r6 = runCli(root, bin, ["generate", "--corpus", dupCorpus, "--candidates", candidates, "--results", join(root, "r4")]);
  assert.equal(r6.status, 2);
  assert.match(r6.stderr, /duplicate case id/);
});

test("case input frozen across candidate arms: mid-run mutation, new-candidate-only invocation", (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);
  // (a) a candidate that mutates the corpus prompt mid-run: the other
  // candidate must still answer the frozen bytes from before any candidate ran
  const corpusA = writingCorpus(root, "corpusA");
  const candidatesA = join(root, "candidatesA.json");
  writeJson(candidatesA, [
    { id: "mut", argv: ["mutator", "@{prompt}"], env: { MUTATE: join(corpusA, "hello.md") } },
    { id: "pi", argv: ["pi", "-p", "@{prompt}"] },
  ]);
  const resultsA = join(root, "resultsA");
  const ra = runCli(root, bin, ["generate", "--corpus", corpusA, "--candidates", candidatesA, "--results", resultsA]);
  assert.equal(ra.status, 0, ra.stderr);
  assert.match(ra.stdout, /generate done: 4 ok, 0 failed, 0 skipped/);
  assert.equal(readFileSync(join(corpusA, "hello.md"), "utf8"), "CHANGED-DURING-RUN\n", "the mutation really happened");
  for (const cand of ["mut", "pi"]) {
    const out = readFileSync(join(resultsA, "hello", cand, "rep-1", "stdout"), "utf8");
    assert.match(out, /teaspoons/, `${cand} answered the frozen prompt`);
    assert.ok(!out.includes("CHANGED-DURING-RUN"), `${cand} never saw the mutated file`);
  }
  // (b) unchanged inputs: adding a new candidate arm is fine
  const corpusB = writingCorpus(root, "corpusB");
  const candidatesB = join(root, "candidatesB.json");
  const resultsB = join(root, "resultsB");
  writeJson(candidatesB, [{ id: "alpha", argv: ["pi", "-p", "@{prompt}"] }]);
  const rb1 = runCli(root, bin, ["generate", "--corpus", corpusB, "--candidates", candidatesB, "--results", resultsB]);
  assert.match(rb1.stdout, /2 ok, 0 failed, 0 skipped/);
  writeJson(candidatesB, [
    { id: "alpha", argv: ["pi", "-p", "@{prompt}"] },
    { id: "beta", argv: ["pi", "-p", "@{prompt}"] },
  ]);
  const rb2 = runCli(root, bin, ["generate", "--corpus", corpusB, "--candidates", candidatesB, "--results", resultsB]);
  assert.match(rb2.stdout, /2 ok, 0 failed, 2 skipped/, "new candidate arm runs, existing arms preserved");
  // (c) the reviewer repro: after a prompt edit, an invocation that adds ONLY
  // a new candidate arm must still be rejected — the freeze is per case, not
  // per revisited attempt dir
  writeFileSync(join(corpusB, "hello.md"), "CHANGED PROMPT\n");
  writeJson(candidatesB, [{ id: "gamma", argv: ["pi", "-p", "@{prompt}"] }]);
  const rb3 = runCli(root, bin, ["generate", "--corpus", corpusB, "--candidates", candidatesB, "--results", resultsB]);
  assert.equal(rb3.status, 2);
  assert.match(rb3.stderr, /different saved case input/);
  assert.ok(!existsSync(join(resultsB, "hello", "gamma")), "no attempt written for the rejected run");
  assert.equal(readFileSync(join(resultsB, "hello", "alpha", "rep-1", "stdout"), "utf8"), readFileSync(join(resultsB, "hello", "beta", "rep-1", "stdout"), "utf8"), "one case, one input");
});

test("generate failures: nonzero exit, bounded process-group lifecycle on every exit path, argv limit", (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);
  const corpus = writingCorpus(root);
  const candidates = join(root, "candidates.json");
  const pgidFile = join(root, "sleeper.pgid");
  const bgPgidFile = join(root, "bg.pgid");
  const coopPidFile = join(root, "coop.pid");
  const orphanPidFile = join(root, "orphan.pid");
  writeJson(candidates, [
    { id: "bad", argv: ["failer"] },
    { id: "slow", argv: ["termignorer", pgidFile] },
    { id: "bg", argv: ["backgrounds", bgPgidFile] },
    { id: "coop", argv: ["coopleader", coopPidFile] },
    { id: "orphan", argv: ["fastorphan", orphanPidFile] },
    { id: "long", argv: ["pi", "x".repeat(900)] },
  ]);
  const results = join(root, "results");
  const args = ["generate", "--corpus", corpus, "--candidates", candidates, "--results", results, "--timeout-ms", "800"];
  const r = runCli(root, bin, args);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /generate done: 4 ok, 8 failed, 0 skipped/);
  const bad = readMeta(join(results, "hello", "bad", "rep-1"));
  assert.equal(bad.status, "failed");
  assert.equal(bad.reason, "nonzero-exit");
  assert.equal(bad.exitCode, 3);
  assert.match(readFileSync(join(results, "hello", "bad", "rep-1", "stderr"), "utf8"), /boom/);
  // leader itself ignores SIGTERM: bounded by timeout + grace, group reaped
  const slow = readMeta(join(results, "hello", "slow", "rep-1"));
  assert.equal(slow.reason, "timeout");
  assert.ok(slow.durationMs < 15000, `timeout is bounded, got ${slow.durationMs}ms`);
  assert.ok(groupGone(pgidFile), "SIGTERM-ignoring child's process group is gone after the bounded timeout");
  // cooperative leader + TERM-ignoring grandchild under timeout: the leader's
  // exit must not cancel the escalation; the grandchild is SIGKILLed before
  // the verdict is written
  const coop = readMeta(join(results, "hello", "coop", "rep-1"));
  assert.equal(coop.reason, "timeout");
  assert.ok(coop.durationMs < 15000, `cooperative-leader timeout bounded, got ${coop.durationMs}ms`);
  assert.ok(procGone(coopPidFile), "TERM-ignoring grandchild reaped even though the leader died on SIGTERM");
  // fast-exiting leader + TERM-ignoring grandchild: success verdict waits for
  // the escalation, nothing outlives the run
  const orphan = readMeta(join(results, "hello", "orphan", "rep-1"));
  assert.equal(orphan.status, "ok");
  assert.ok(orphan.durationMs < 15000, `fast exit stays bounded, got ${orphan.durationMs}ms`);
  assert.ok(procGone(orphanPidFile), "TERM-ignoring grandchild reaped after a fast leader exit");
  // cooperative background helper: reaped by the group SIGTERM, no false timeout
  const bg = readMeta(join(results, "hello", "bg", "rep-1"));
  assert.equal(bg.status, "ok");
  assert.ok(groupGone(bgPgidFile), "backgrounded grandchild's process group reaped after success");
  const long = readMeta(join(results, "hello", "long", "rep-1"));
  assert.equal(long.reason, "argv-limit");
  assert.match(long.message, /@file/);
  const before = readFileSync(join(results, "hello", "bad", "rep-1", "meta.json"), "utf8");
  const r2 = runCli(root, bin, args);
  assert.match(r2.stdout, /0 ok, 0 failed, 12 skipped/);
  assert.equal(readFileSync(join(results, "hello", "bad", "rep-1", "meta.json"), "utf8"), before, "failures preserved verbatim");
});

test("review cases: guards bind to the candidate's cwd, full-SHA pinning, diff snapshot", (t) => {
  const mk = () => {
    const root = mkroot(t);
    const bin = stubBin(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "util.js"), "module.exports = (x) => x + 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--no-verify", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "search.js"), "module.exports = 2;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--no-verify", "-m", "replay");
    const replay = git(repo, "rev-parse", "HEAD");
    const corpus = join(root, "corpus");
    mkdirSync(corpus);
    writeFileSync(join(corpus, "review-task.md"), "Grade the review JSON.\n");
    writeJson(join(corpus, "cases.json"), [
      { id: "pr1", promptFile: "review-task.md", expectations: "EXPECTSECRET-PR", rubric: RUBRIC, repo, base, replay },
    ]);
    const candidates = join(root, "candidates.json");
    writeJson(candidates, [{ id: "grep", argv: ["greptile", "review", "-b", "{base}", "--json"], cwd: "{repo}" }]);
    return { root, bin, repo, base, replay, corpus, candidates };
  };
  const gen = (f: ReturnType<typeof mk>, candidates = f.candidates) =>
    runCli(f.root, f.bin, ["generate", "--corpus", f.corpus, "--candidates", candidates, "--results", join(f.root, "results")]);

  {
    // happy path: candidate cwd is the pinned checkout (HEAD == replay, clean, base is ancestor)
    const f = mk();
    const r = gen(f);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 ok, 0 failed/);
    const dir = join(f.root, "results", "pr1", "grep", "rep-1");
    const meta = readMeta(dir);
    assert.equal(meta.status, "ok");
    assert.ok(!("reviewId" in meta), "no invented runId: the real 3.6.1 JSON renderer has none");
    assert.match(r.trace(), /^greptile review -b [0-9a-f]{40} --json$/m);
    assert.equal(meta.cwd, f.repo, "candidate ran in the pinned checkout");
    const diff = readFileSync(join(dir, "diff.patch"), "utf8");
    assert.equal(diff, git(f.repo, "diff", f.base, f.replay) + "\n", "pinned base→replay diff snapshot saved");
    assert.match(diff, /search\.js/);
    // the frozen case manifest pins the review coordinates too
    const caseInput = JSON.parse(readFileSync(join(f.root, "results", "pr1", "case-input.json"), "utf8"));
    assert.equal(caseInput.base, f.base);
    assert.equal(caseInput.replay, f.replay);
  }
  {
    // HEAD moved past the pinned replay SHA
    const f = mk();
    writeFileSync(join(f.repo, "later.js"), "// later\n");
    git(f.repo, "add", "-A");
    git(f.repo, "commit", "-q", "--no-verify", "-m", "later");
    const r = gen(f);
    assert.match(r.stdout, /0 ok, 1 failed/);
    const meta = readMeta(join(f.root, "results", "pr1", "grep", "rep-1"));
    assert.equal(meta.reason, "guard");
    assert.match(meta.message, /HEAD is [0-9a-f]{40}, expected pinned replay/);
    assert.equal(r.trace(), "", "guarded attempt never spawns the candidate");
  }
  {
    // candidate cwd points at a DIFFERENT checkout than the pinned repo: guard
    // binds to the actual execution directory, not to case.repo on paper
    const f = mk();
    const other = join(f.root, "other");
    mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    writeFileSync(join(other, "x.js"), "// unrelated\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "--no-verify", "-m", "other");
    writeJson(f.candidates, [{ id: "grep", argv: ["greptile", "review", "-b", "{base}", "--json"], cwd: other }]);
    const r = gen(f);
    assert.match(r.stdout, /0 ok, 1 failed/);
    const meta = readMeta(join(f.root, "results", "pr1", "grep", "rep-1"));
    assert.equal(meta.reason, "guard");
    assert.match(meta.message, /HEAD is [0-9a-f]{40}, expected pinned replay/);
    assert.equal(r.trace(), "");
  }
  {
    // dirty worktree at the right HEAD
    const f = mk();
    writeFileSync(join(f.repo, "dirty.js"), "// dirty\n");
    const r = gen(f);
    const meta = readMeta(join(f.root, "results", "pr1", "grep", "rep-1"));
    assert.equal(meta.reason, "guard");
    assert.match(meta.message, /not clean/);
    assert.equal(r.trace(), "");
  }
  {
    // base not an ancestor of replay (swapped pair)
    const f = mk();
    git(f.repo, "checkout", "-q", f.base); // HEAD == the swapped "replay"
    writeJson(join(f.corpus, "cases.json"), [
      { id: "pr1", promptFile: "review-task.md", expectations: "E", rubric: RUBRIC, repo: f.repo, base: f.replay, replay: f.base },
    ]);
    const r = gen(f);
    const meta = readMeta(join(f.root, "results", "pr1", "grep", "rep-1"));
    assert.equal(meta.reason, "guard");
    assert.match(meta.message, /not an ancestor/);
    assert.equal(r.trace(), "");
  }
  {
    // moving refs are not pins: replay must be a full immutable SHA
    const f = mk();
    writeJson(join(f.corpus, "cases.json"), [
      { id: "pr1", promptFile: "review-task.md", expectations: "E", rubric: RUBRIC, repo: f.repo, base: f.base, replay: "HEAD" },
    ]);
    const r = gen(f);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /full commit SHA/);
    assert.equal(r.trace(), "");
  }
});

test("grade: protocol revisions, instruction bytes, unique neutral staging, provenance, grader cwd", (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);
  const corpus = writingCorpus(root);
  const candidates = join(root, "candidates.json");
  writeJson(candidates, [
    { id: "alpha", argv: ["pi", "-p", "@{prompt}"] },
    { id: "beta", argv: ["pi", "-p", "@{prompt}"] },
  ]);
  const results = join(root, "results");
  runCli(root, bin, ["generate", "--corpus", corpus, "--candidates", candidates, "--results", results]);
  writeFileSync(join(root, "note.md"), "CONFIGDIR-NOTE-MARKER\n");
  const sub = join(root, "sub");
  mkdirSync(sub);
  const graders = join(root, "graders.json");
  const g0argv = ["pi", "@{configDir}/note.md", "@{output}", "@{expectations}", "@{rubric}"];
  const g1argv = ["grader", "@{output}", "@{expectations}"];
  writeJson(graders, [
    { id: "g0", argv: g0argv },
    { id: "g1", argv: g1argv },
    { id: "g2", argv: ["grader2", "@{output}"] },
    { id: "bad", argv: ["badgrader", "@{output}"] },
    { id: "late", argv: ["latejson", "@{output}"] },
    { id: "open", argv: ["openjson", "@{output}"] },
    { id: "wrong", argv: ["wrongkeys", "@{output}"] },
    { id: "range", argv: ["outofrange", "@{output}"] },
    { id: "g3", argv: ["pwdgrader", "@{output}"], cwd: "sub" },
    { id: "g4", argv: ["pwdgrader", "@{output}"], cwd: "/does/not/exist" },
  ]);
  const gargs = ["grade", "--corpus", corpus, "--graders", graders, "--results", results];
  const r = runCli(root, bin, gargs);
  assert.equal(r.status, 0, r.stderr);
  // g0,g1,g2,g3 ok (4×4), bad+late+open+wrong+range+g4 fail (4×6)
  assert.match(r.stdout, /grade done: 16 ok, 24 failed, 0 skipped/);
  const rev1 = join(results, "hello", "alpha", "rep-1", "grades", "g1", "rev-1");
  assert.deepEqual(JSON.parse(readFileSync(join(rev1, "parsed.json"), "utf8")).criteria, { "answer-first": 2, facts: 1 });
  assert.match(readFileSync(join(rev1, "stdout"), "utf8"), /g1 stub grade/, "raw grader response kept");
  // {configDir} camelCase resolves; the grader executed the SNAPSHOT bytes
  const g0 = join(results, "hello", "alpha", "rep-1", "grades", "g0", "rev-1");
  assert.match(readFileSync(join(g0, "stdout"), "utf8"), /CONFIGDIR-NOTE-MARKER/);
  // external instruction bytes are copied into the revision, not just hashed
  assert.equal(readFileSync(join(g0, "instructions", "0-note.md"), "utf8"), "CONFIGDIR-NOTE-MARKER\n", "exact instruction bytes preserved with the grade");
  assert.equal(readFileSync(join(rev1, "expectations.md"), "utf8"), "EXPECTSECRET-1: must mention teaspoons\n");
  assert.match(readFileSync(join(rev1, "rubric.md"), "utf8"), /- answer-first: 0\.\.2/);
  // protocol identity: command/settings + rubric + expectations + instruction bytes
  const ginput = JSON.parse(readFileSync(join(rev1, "input.json"), "utf8"));
  assert.deepEqual(ginput.protocol.argv, g1argv);
  assert.deepEqual(ginput.protocol.rubric, RUBRIC);
  assert.equal(ginput.protocol.expectations, "EXPECTSECRET-1: must mention teaspoons\n");
  assert.deepEqual(ginput.protocol.instructions, [], "g1 declares no external instruction files");
  assert.equal(ginput.source.candidate, "alpha");
  const g0input = JSON.parse(readFileSync(join(g0, "input.json"), "utf8"));
  assert.equal(g0input.protocol.instructions.length, 1);
  assert.match(g0input.protocol.instructions[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(g0input.protocol.instructions[0].sha256, sha256File(join(root, "note.md")), "instruction hash covers the exact bytes");
  assert.match(Object.keys(g0input.argvFiles).join("\n"), /note\.md/, "referenced files hashed per grade");
  const gmeta = JSON.parse(readFileSync(join(rev1, "meta.json"), "utf8"));
  assert.equal(gmeta.rev, 1);
  assert.ok(gmeta.argv.length > 0 && typeof gmeta.cwd === "string", "resolved argv+cwd saved per grade");
  // model-visible grader inputs are neutral: each grade gets its OWN mkdtemp
  // staging dir (never a shared path), free of any candidate identity
  const gradeLines = r.trace().split("\n").filter((l) => l.includes(".grading-"));
  assert.equal(gradeLines.length, 36, "every executed grade staged its inputs");
  const stageDirs = gradeLines.map((l) => /\.grading-[^/\s"]+/.exec(l)?.[0]);
  assert.equal(new Set(stageDirs).size, stageDirs.length, "staging dir is unique per grading invocation");
  for (const line of gradeLines) {
    for (const tok of line.split(" ").filter((x) => x.startsWith("@"))) {
      assert.ok(!tok.includes("/alpha/") && !tok.includes("/beta/"), `no candidate identity in grader input path: ${tok}`);
    }
  }
  assert.ok(gradeLines.some((l) => /\.grading-[^/]+\/answer/.test(l)), "grader reads the neutral staged answer");
  assert.equal(
    readdirSync(results).filter((d) => d.startsWith(".grading")).length,
    0,
    "staging dirs are removed after each grade; canonical bytes stay in the revision",
  );
  // bad/final-block/rubric grades failed, raw output kept
  for (const [gid, reason] of [["bad", "unparseable"], ["late", "unparseable"], ["open", "unparseable"], ["wrong", "rubric-mismatch"], ["range", "rubric-mismatch"]] as const) {
    const m = JSON.parse(readFileSync(join(results, "hello", "alpha", "rep-1", "grades", gid, "rev-1", "meta.json"), "utf8"));
    assert.equal(m.status, "failed", gid);
    assert.equal(m.reason, reason, gid);
  }
  const openMeta = JSON.parse(readFileSync(join(results, "hello", "alpha", "rep-1", "grades", "open", "rev-1", "meta.json"), "utf8"));
  assert.match(openMeta.message, /never closed/, "an unterminated final block is a failed grade, not a reused earlier one");
  // grader cwd honored: g3 ran in the configured subdir, g4 failed on the missing dir
  const g3parsed = JSON.parse(readFileSync(join(results, "hello", "alpha", "rep-1", "grades", "g3", "rev-1", "parsed.json"), "utf8"));
  assert.equal(g3parsed.notes, `cwd=${sub}`);
  const g4meta = JSON.parse(readFileSync(join(results, "hello", "alpha", "rep-1", "grades", "g4", "rev-1", "meta.json"), "utf8"));
  assert.equal(g4meta.status, "failed");
  assert.equal(g4meta.reason, "spawn-error");
  const piSpawns = () => r.trace().split("\n").filter((l) => l.startsWith("pi ")).length;
  assert.equal(piSpawns(), 8, "4 candidate runs + 4 g0 grade runs, nothing else");
  // regrade: everything matches its latest revision's protocol → skipped
  const r2 = runCli(root, bin, gargs);
  assert.match(r2.stdout, /grade done: 0 ok, 0 failed, 40 skipped/);
  // changed expectations: NEW revision with the new inputs, old one preserved
  writeJson(join(corpus, "cases.json"), [
    { id: "hello", promptFile: "hello.md", expectations: "EXPECTSECRET-1-V2: teaspoons, revised", rubric: RUBRIC },
    { id: "bye", promptFile: "bye.md", expectations: "EXPECTSECRET-2: must mention farewells", rubric: RUBRIC },
  ]);
  const r3 = runCli(root, bin, gargs);
  assert.match(r3.stdout, /grade done: 8 ok, 12 failed, 20 skipped/);
  const rev2 = join(results, "hello", "alpha", "rep-1", "grades", "g1", "rev-2");
  assert.equal(readFileSync(join(rev2, "expectations.md"), "utf8"), "EXPECTSECRET-1-V2: teaspoons, revised\n");
  assert.equal(readFileSync(join(rev1, "expectations.md"), "utf8"), "EXPECTSECRET-1: must mention teaspoons\n", "old revision preserved");
  // changed instruction BYTES: new revision, never a silent skip; the revision
  // holds the exact bytes it executed and the previous revision keeps its own
  writeFileSync(join(root, "note.md"), "CONFIGDIR-NOTE-MARKER-V2\n");
  const r4 = runCli(root, bin, gargs);
  assert.match(r4.stdout, /grade done: 4 ok, 0 failed, 36 skipped/, "only g0's protocol changed");
  const g0rev3 = join(results, "hello", "alpha", "rep-1", "grades", "g0", "rev-3");
  assert.equal(readFileSync(join(g0rev3, "instructions", "0-note.md"), "utf8"), "CONFIGDIR-NOTE-MARKER-V2\n", "new revision carries the new instruction bytes");
  const g0rev2 = join(results, "hello", "alpha", "rep-1", "grades", "g0", "rev-2");
  assert.equal(readFileSync(join(g0rev2, "instructions", "0-note.md"), "utf8"), "CONFIGDIR-NOTE-MARKER\n", "previous revision keeps the bytes it ran with");
  assert.match(readFileSync(join(g0rev3, "stdout"), "utf8"), /CONFIGDIR-NOTE-MARKER-V2/, "the grader executed the new snapshot");
  // changed grader argv under the same id: new revision, not a skip
  writeJson(graders, [
    { id: "g0", argv: g0argv },
    { id: "g1", argv: ["grader", "--extra-flag", "@{output}", "@{expectations}"] },
    { id: "g2", argv: ["grader2", "@{output}"] },
    { id: "bad", argv: ["badgrader", "@{output}"] },
    { id: "late", argv: ["latejson", "@{output}"] },
    { id: "open", argv: ["openjson", "@{output}"] },
    { id: "wrong", argv: ["wrongkeys", "@{output}"] },
    { id: "range", argv: ["outofrange", "@{output}"] },
    { id: "g3", argv: ["pwdgrader", "@{output}"], cwd: "sub" },
    { id: "g4", argv: ["pwdgrader", "@{output}"], cwd: "/does/not/exist" },
  ]);
  const r5 = runCli(root, bin, gargs);
  assert.match(r5.stdout, /grade done: 4 ok, 0 failed, 36 skipped/, "only g1's protocol changed");
  const g1rev3 = JSON.parse(readFileSync(join(results, "hello", "alpha", "rep-1", "grades", "g1", "rev-3", "input.json"), "utf8"));
  assert.ok(g1rev3.protocol.argv.includes("--extra-flag"), "grader command change is a new protocol");
  const piSpawnsAfter = r5.trace().split("\n").filter((l) => l.startsWith("pi ") && l.includes("/hello/prompt.md")).length;
  assert.equal(piSpawnsAfter, 2, "regrading never re-runs candidates (alpha+beta on hello, once)");
});

test("tabulate: deterministic, escaped notes, changed-protocol grouping, corrupt/interrupted grades", (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);
  const corpus = writingCorpus(root);
  const candidates = join(root, "candidates.json");
  writeJson(candidates, [
    { id: "alpha", argv: ["pi", "-p", "@{prompt}"] },
    { id: "beta", argv: ["pi", "-p", "@{prompt}"] },
    { id: "bad", argv: ["failer"] },
  ]);
  const results = join(root, "results");
  runCli(root, bin, ["generate", "--corpus", corpus, "--candidates", candidates, "--results", results]);
  const graders = join(root, "graders.json");
  writeJson(graders, [
    { id: "g1", argv: ["grader", "@{output}", "@{expectations}"] },
    { id: "g2", argv: ["grader2", "@{output}"] },
    { id: "bad", argv: ["badgrader", "@{output}"] },
    { id: "evil", argv: ["evilnotes", "@{output}"] },
  ]);
  runCli(root, bin, ["grade", "--corpus", corpus, "--graders", graders, "--results", results]);
  // an interrupted attempt: output present, no meta.json (runner died mid-spawn)
  const cut = join(results, "hello", "alpha", "rep-7");
  mkdirSync(cut, { recursive: true });
  writeFileSync(join(cut, "stdout"), "partial");
  // an interrupted grade: rev dir exists, meta.json was never written
  const cutGrade = join(results, "hello", "beta", "rep-1", "grades", "g2", "rev-2");
  mkdirSync(cutGrade, { recursive: true });
  writeFileSync(join(cutGrade, "stdout"), "partial grade");
  // a corrupt grade: meta claims ok but parsed.json is unreadable
  const corrupt = join(results, "bye", "beta", "rep-1", "grades", "g1", "rev-1");
  writeFileSync(join(corrupt, "parsed.json"), "{TRUNCATED");
  // a changed grading protocol under one grader: craft rev-2 for
  // alpha/hello/g1 with a different rubric (the state an interrupted partial
  // regrade leaves behind) — the two protocols must never share a table
  const a1 = join(results, "hello", "alpha", "rep-1", "grades", "g1");
  cpSync(join(a1, "rev-1"), join(a1, "rev-2"), { recursive: true });
  const newRubric = { "answer-first": 2, facts: 2, style: 1 };
  const a1input = JSON.parse(readFileSync(join(a1, "rev-2", "input.json"), "utf8"));
  a1input.protocol.rubric = newRubric;
  a1input.protocol.expectations = "PROTOCOL-V2 expectations";
  writeJson(join(a1, "rev-2", "input.json"), a1input);
  writeJson(join(a1, "rev-2", "parsed.json"), { criteria: { "answer-first": 2, facts: 2, style: 1 }, notes: "v2 grade" });
  const targs = ["tabulate", "--results", results];
  const r = runCli(root, bin, targs);
  assert.equal(r.status, 0, r.stderr);
  const tables = join(results, "tables.md");
  const first = readFileSync(tables, "utf8");
  const traceBefore = r.trace();
  const r2 = runCli(root, bin, targs);
  assert.equal(readFileSync(tables, "utf8"), first, "deterministic: byte-identical rerun");
  assert.equal(r2.trace(), traceBefore, "tabulation makes no model calls");
  assert.match(first, /## Case hello\n/);
  assert.match(first, /### Grader g1\n/);
  assert.match(first, /\| Candidate \| Rep \| answer-first \| facts \| Total \(max 4\) \|\n/);
  assert.match(first, /\| beta \| 1 \| 2 \| 1 \| 3 \/ 4 \|\n/);
  assert.match(first, /### Grader g2\n[\s\S]*\| beta \| 1 \| 1 \| 2 \| 3 \/ 4 \|/);
  assert.match(first, /- bad rep-1: nonzero-exit — exit code 3\n/);
  assert.match(first, /- alpha rep-7: interrupted \(no meta\.json/);
  assert.match(first, /- alpha rep-1: grade bad failed — unparseable/);
  assert.match(first, /- beta rep-1: grade g2 interrupted \(rev-2 has no meta\.json\)/);
  assert.match(first, /- beta rep-1: grade g1 corrupt \(parsed\.json\)/);
  // grader notes are escaped: no fabricated rows, no raw newlines
  assert.match(first, /forged \\| pipe second line/);
  assert.ok(!/^second line$/m.test(first), "no injected newline in tables.md");
  // the changed protocol renders as a separate, explicitly non-comparable table
  assert.match(first, /grading protocol changed between grades under this grader — totals across these tables are not comparable/);
  assert.match(first, /Protocol [0-9a-f]{8}:\n\n\| Candidate \| Rep \| answer-first \| facts \| style \| Total \(max 5\) \|\n/);
  assert.match(first, /\| alpha \| 1 \| 2 \| 2 \| 1 \| 5 \/ 5 \|\n/);
  assert.match(first, /Notes \(g1, protocol [0-9a-f]{8}\):\n- beta rep-1: g1 stub grade/);
  assert.match(first, /Notes \(g1\):\n- alpha rep-1: g1 stub grade/);
});

test("blind: fenced samples, honor-system note, deterministic key; summarize snapshots inputs pre-spawn", (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);
  const corpus = writingCorpus(root);
  const candidates = join(root, "candidates.json");
  writeJson(candidates, [
    { id: "alpha", argv: ["forger"] },
    { id: "beta", argv: ["pi", "-p", "@{prompt}"] },
  ]);
  const results = join(root, "results");
  runCli(root, bin, ["generate", "--corpus", corpus, "--candidates", candidates, "--results", results]);
  const bargs = ["blind", "--results", results, "--seed", "hunter2"];
  const r = runCli(root, bin, bargs);
  assert.equal(r.status, 0, r.stderr);
  const blind = readFileSync(join(results, "blind.md"), "utf8");
  assert.match(blind, /## Case hello\n/);
  assert.match(blind, /### Sample A — rep 1\n/);
  assert.match(blind, /honor-system/);
  assert.match(blind, /teaspoons/);
  assert.ok(!blind.includes("alpha") && !blind.includes("beta"), "candidate identities hidden");
  assert.ok(!blind.includes("EXPECTSECRET"), "expectations hidden");
  // candidate output is fenced by indentation: a forged Sample heading stays text
  const forged = blind.match(/^ {4}### Sample B — rep 1$/gm) ?? [];
  assert.equal(forged.length, 2, "alpha's forged heading appears indented in both cases");
  const realB = blind.match(/^### Sample B — rep 1$/gm) ?? [];
  assert.equal(realB.length, 2, "only the runner's own headings are unindented (one Sample B per case)");
  const r2 = runCli(root, bin, bargs);
  assert.equal(readFileSync(join(results, "blind.md"), "utf8"), blind, "same seed → same bytes");
  const key = JSON.parse(readFileSync(join(results, "blind-key.json"), "utf8"));
  assert.deepEqual(Object.values(key.hello).sort(), ["alpha", "beta"]);
  // summarize: separate stage over saved tables; snapshots the exact inputs
  // BEFORE spawning and passes those snapshots
  runCli(root, bin, ["tabulate", "--results", results]);
  const cmdDir = join(root, "sumdir");
  mkdirSync(cmdDir);
  const cmd = join(root, "summarizer.json");
  writeJson(cmd, { argv: ["summarizer", "@{tables}"], cwd: "sumdir" });
  const rs = runCli(root, bin, ["summarize", "--results", results, "--cmd", cmd]);
  assert.equal(rs.status, 0, rs.stderr);
  const good = readFileSync(join(results, "summary.md"), "utf8");
  assert.match(good, /# Comparison tables/);
  assert.ok(good.startsWith(`${cmdDir}\n`), "summarizer cwd honored");
  const smeta = JSON.parse(readFileSync(join(results, "summary.meta.json"), "utf8"));
  assert.equal(smeta.status, "ok");
  assert.match(smeta.tablesSha256, /^[0-9a-f]{64}$/);
  assert.equal(smeta.tablesSha256, sha256File(join(results, "summary-attempt-tables.md")), "hash covers the pre-spawn snapshot the summarizer read");
  assert.ok(smeta.argv.some((a: string) => a.includes("summary-attempt-tables.md")), "summarizer was passed the snapshot, not the live file");
  assert.equal(smeta.blind.sha256, sha256File(join(results, "summary-attempt-blind.md")), "blind snapshot hashed too");
  assert.equal(readFileSync(join(results, "summary-tables.md"), "utf8"), readFileSync(join(results, "tables.md"), "utf8"), "exact tables snapshot kept with the summary");
  // a failed summarizer never destroys the previous successful summary
  writeJson(cmd, { argv: ["failsum", "@{tables}"] });
  const rs2 = runCli(root, bin, ["summarize", "--results", results, "--cmd", cmd]);
  assert.equal(rs2.status, 2);
  assert.match(rs2.stderr, /summarizer failed/);
  assert.equal(readFileSync(join(results, "summary.md"), "utf8"), good, "previous summary preserved");
  const fmeta = JSON.parse(readFileSync(join(results, "summary-failed.meta.json"), "utf8"));
  assert.equal(fmeta.status, "failed");
  assert.match(readFileSync(join(results, "summary-attempt.md"), "utf8"), /partial garbage/, "failed attempt output kept separately");
  // a summarizer that rewrites the live tables.md mid-run: the saved snapshot
  // and hash are the PRE-SPAWN bytes it was actually fed
  const preSpawnBytes = readFileSync(join(results, "tables.md"), "utf8");
  writeJson(cmd, { argv: ["mutsum", "@{tables}"] });
  const rs3 = runCli(root, bin, ["summarize", "--results", results, "--cmd", cmd], { MUTATE_TABLES: join(results, "tables.md") });
  assert.equal(rs3.status, 0, rs3.stderr);
  assert.equal(readFileSync(join(results, "tables.md"), "utf8"), "REPLACED WHILE RUNNING\n", "the mutation really happened during the run");
  assert.equal(readFileSync(join(results, "summary-tables.md"), "utf8"), preSpawnBytes, "saved snapshot is what the summarizer was fed");
  const smeta3 = JSON.parse(readFileSync(join(results, "summary.meta.json"), "utf8"));
  assert.equal(smeta3.tablesSha256, createHash("sha256").update(preSpawnBytes).digest("hex"), "recorded hash covers the pre-spawn bytes");
});

test("shipped examples run end-to-end offline: writing + greptile, controlled pi dir, neutral real-Pi inputs", async (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);

  // --- examples/writing through all five stages with stub pi on PATH ---
  const wcorpus = join(REPO, "examples", "writing");
  const wresults = join(root, "wresults");
  const shippedCandidates = JSON.parse(readFileSync(join(wcorpus, "candidates.json"), "utf8")) as Array<{ argv: string[]; env?: Record<string, string> }>;
  for (const c of shippedCandidates) {
    assert.ok(c.argv.includes("--no-approve"), "shipped pi candidates disable project-local configuration");
    assert.ok(c.env?.PI_CODING_AGENT_DIR?.includes("pi-agent"), "shipped pi candidates use the controlled agent dir");
  }
  // shipped writing contracts: tool-less pi under a pinned provider, the
  // grader's documented prompt-before-reply order, no silent model fallback
  const shippedGraders = JSON.parse(readFileSync(join(wcorpus, "graders.json"), "utf8")) as Array<{ argv: string[] }>;
  const summarizerCmd = JSON.parse(readFileSync(join(wcorpus, "summarizer.json"), "utf8")) as { argv: string[] };
  for (const [label, cmds] of [
    ["candidates", shippedCandidates],
    ["graders", shippedGraders],
    ["summarizer", [summarizerCmd]],
  ] as const) {
    for (const c of cmds) {
      assert.ok(c.argv.includes("--no-tools"), `${label}: shipped pi commands run tool-less — expectations and sibling artifacts must stay unreadable`);
      assert.match(c.argv[c.argv.indexOf("--model") + 1], /^cloudflare-ai-gateway\//, `${label}: the provider is pinned, never resolved from ambient auth`);
    }
  }
  for (const g of shippedGraders) {
    assert.ok(
      g.argv.indexOf("@{prompt}") !== -1 && g.argv.indexOf("@{prompt}") < g.argv.indexOf("@{output}"),
      "grader argv feeds the original prompt before the reply, as grader-prompt.md documents",
    );
  }
  assert.ok(
    !JSON.stringify(JSON.parse(readFileSync(join(REPO, "examples", "pi-agent", "models.json"), "utf8"))).includes("allowedFallbackModels"),
    "no fallback model may answer under a fixed candidate/grader label",
  );
  const g = runCli(root, bin, ["generate", "--corpus", wcorpus, "--candidates", join(wcorpus, "candidates.json"), "--results", wresults]);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /generate done: 16 ok, 0 failed, 0 skipped/);
  // the controlled agent dir reached the child and was snapshotted into the results
  const attempt1 = join(wresults, "F1-nest", "fable", "rep-1");
  const input1 = JSON.parse(readFileSync(join(attempt1, "input.json"), "utf8"));
  assert.match(input1.agentConfig.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    readFileSync(join(wresults, ".agent-config", input1.agentConfig.sha256, "models.json"), "utf8"),
    readFileSync(join(REPO, "examples", "pi-agent", "models.json"), "utf8"),
    "non-secret effective pi config captured with the run",
  );
  const out1 = readFileSync(join(attempt1, "stdout"), "utf8");
  assert.match(out1, /AGENTDIR=\S*\.agent-run-/, "child executed a private per-process copy of the controlled config");
  assert.ok(!out1.includes("examples/pi-agent"), "the child never touches the mutable source dir");
  const meta1 = readMeta(attempt1);
  assert.equal(meta1.env.PI_CODING_AGENT_DIR, join(REPO, "examples", "pi-agent"), "recorded env keeps the logical source path, not the ephemeral runtime dir");
  const gr = runCli(root, bin, ["grade", "--corpus", wcorpus, "--graders", join(wcorpus, "graders.json"), "--results", wresults]);
  assert.equal(gr.status, 0, gr.stderr);
  assert.match(gr.stdout, /grade done: 32 ok, 0 failed, 0 skipped/);
  // the shipped {configDir} template resolved: grade stdout contains the prompt file's text
  const grev = join(wresults, "F1-nest", "fable", "rep-1", "grades", "grader-fable", "rev-1");
  assert.match(readFileSync(join(grev, "stdout"), "utf8"), /You are grading one agent reply/);
  // the grader instruction bytes are saved with the revision
  assert.equal(
    readFileSync(join(grev, "instructions", "0-grader-prompt.md"), "utf8"),
    readFileSync(join(wcorpus, "grader-prompt.md"), "utf8"),
    "exact grader instruction bytes preserved",
  );
  const gr2 = runCli(root, bin, ["grade", "--corpus", wcorpus, "--graders", join(wcorpus, "graders.json"), "--results", wresults]);
  assert.match(gr2.stdout, /grade done: 0 ok, 0 failed, 32 skipped/, "regrade skips; results frozen under same inputs");
  const tb = runCli(root, bin, ["tabulate", "--results", wresults]);
  assert.equal(tb.status, 0, tb.stderr);
  const wtables = readFileSync(join(wresults, "tables.md"), "utf8");
  assert.match(wtables, /\| Candidate \| Rep \| answer-first \| readability \| required-facts \| writer-protection \| Total \(max 8\) \|/);
  const bl = runCli(root, bin, ["blind", "--results", wresults, "--seed", "demo"]);
  assert.equal(bl.status, 0, bl.stderr);
  const sm = runCli(root, bin, ["summarize", "--results", wresults, "--cmd", join(wcorpus, "summarizer.json")]);
  assert.equal(sm.status, 0, sm.stderr);
  assert.match(readFileSync(join(wresults, "summary.md"), "utf8"), /# Comparison tables/);
  assert.equal(
    readdirSync(wresults).filter((d) => d.startsWith(".agent-run-")).length,
    0,
    "per-process runtime agent dirs are removed after each child",
  );
  const summeta = JSON.parse(readFileSync(join(wresults, "summary.meta.json"), "utf8"));
  assert.match(summeta.agentConfig.sha256, /^[0-9a-f]{64}$/, "summarizer runs under the same controlled config discipline");

  // the shipped grader argv feeds the REAL installed Pi file processor only
  // identity-free staging paths (offline: file processing, no model call)
  const processor = join(REPO, ".pi-types", "@earendil-works", "pi-coding-agent", "dist", "cli", "file-processor.js");
  if (existsSync(processor)) {
    const probe = join(root, "pi-file-probe.mjs");
    writeFileSync(
      probe,
      `import { processFileArguments } from ${JSON.stringify(`file://${processor}`)};\n` +
        "const { text } = await processFileArguments(process.argv.slice(2).filter((x) => x.startsWith('@')).map((x) => x.slice(1)));\n" +
        "console.log(text);\n",
    );
    // reconstruct the grade's model-visible argv from the revision's canonical
    // bytes, staged at neutral paths exactly like the runner stages them
    // (staging dirs are ephemeral by design; canonical paths carry identity)
    const ginput = JSON.parse(readFileSync(join(grev, "input.json"), "utf8"));
    const probeStage = mkdtempSync(join(root, "probe-stage-"));
    for (const f of ["answer", "prompt.md", "expectations.md", "rubric.md"]) copyFileSync(join(grev, f), join(probeStage, f));
    copyFileSync(join(grev, "instructions", ginput.protocol.instructions[0].as), join(probeStage, ginput.protocol.instructions[0].as));
    const staged = ["answer", "prompt.md", "expectations.md", "rubric.md", ginput.protocol.instructions[0].as].map((f) => `@${join(probeStage, f)}`);
    const seen = spawnSync(process.execPath, [probe, ...staged], { encoding: "utf8" });
    assert.equal(seen.status, 0, seen.stderr);
    assert.ok(!seen.stdout.includes("/fable/") && !seen.stdout.includes("/astra/"), "no candidate identity in model-visible file names");
    assert.match(seen.stdout, /You are grading one agent reply/);
  } else {
    t.skip(".pi-types missing (run npm run types) — real-Pi file-processing check skipped");
  }

  // changed-rubric regrading on the shipped example configs: copy the corpus
  // to scratch (absolute prompt paths), grade, change one case's rubric, and
  // regrade — a new revision grades the new rubric, the old one is preserved
  const wfix = join(root, "wcopy");
  mkdirSync(wfix);
  interface WritingCase {
    id: string;
    promptFile?: string;
    rubric: Record<string, number>;
  }
  const casesCopy = JSON.parse(readFileSync(join(wcorpus, "cases.json"), "utf8")) as WritingCase[];
  for (const c of casesCopy) if (c.promptFile) c.promptFile = resolve(wcorpus, c.promptFile);
  writeJson(join(wfix, "cases.json"), casesCopy);
  for (const f of ["graders.json", "grader-prompt.md"]) copyFileSync(join(wcorpus, f), join(wfix, f));
  const wfixGraders = JSON.parse(readFileSync(join(wfix, "graders.json"), "utf8")) as Array<{ env: Record<string, string> }>;
  for (const gr_ of wfixGraders) gr_.env.PI_CODING_AGENT_DIR = join(REPO, "examples", "pi-agent");
  writeJson(join(wfix, "graders.json"), wfixGraders);
  const wresults2 = join(root, "wresults2");
  const wg = runCli(root, bin, ["generate", "--corpus", wfix, "--candidates", join(wcorpus, "candidates.json"), "--results", wresults2]);
  assert.equal(wg.status, 0, wg.stderr);
  assert.match(wg.stdout, /generate done: 16 ok, 0 failed, 0 skipped/);
  const wgr = runCli(root, bin, ["grade", "--corpus", wfix, "--graders", join(wfix, "graders.json"), "--results", wresults2]);
  assert.match(wgr.stdout, /grade done: 32 ok, 0 failed, 0 skipped/);
  const changedCase = casesCopy[0].id;
  casesCopy[0].rubric = { ...casesCopy[0].rubric, brevity: 2 };
  writeJson(join(wfix, "cases.json"), casesCopy);
  const wgr2 = runCli(root, bin, ["grade", "--corpus", wfix, "--graders", join(wfix, "graders.json"), "--results", wresults2]);
  assert.match(wgr2.stdout, /grade done: 4 ok, 0 failed, 28 skipped/, "only the changed case's attempts regrade");
  const changedRev2 = join(wresults2, changedCase, "fable", "rep-1", "grades", "grader-fable", "rev-2");
  assert.match(readFileSync(join(changedRev2, "rubric.md"), "utf8"), /- brevity: 0\.\.2/, "new revision grades the changed rubric");
  const changedRev1 = join(wresults2, changedCase, "fable", "rep-1", "grades", "grader-fable", "rev-1");
  assert.ok(!readFileSync(join(changedRev1, "rubric.md"), "utf8").includes("brevity"), "old revision's rubric preserved");
  assert.ok(existsSync(join(changedRev1, "parsed.json")), "old revision's grade preserved");
  const wt2 = runCli(root, bin, ["tabulate", "--results", wresults2]);
  assert.equal(wt2.status, 0, wt2.stderr);
  assert.match(readFileSync(join(wresults2, "tables.md"), "utf8"), /brevity/, "tables reflect the regraded rubric");

  // --- examples/greptile offline fixture with stub greptile + stub pi ---
  const gfix = join(root, "gfix");
  const mk = spawnSync("sh", [join(REPO, "examples", "greptile", "make-fixture.sh"), gfix], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  assert.match(mk.stdout, /offline/i, "fixture marks itself offline-only");
  assert.ok(!mk.stdout.includes("node scripts/compare.ts generate"), "fixture does not advertise a live run as the next step");
  const gresults = join(root, "gresults");
  const gg = runCli(root, bin, [
    "generate", "--corpus", join(gfix, "corpus"), "--candidates", join(REPO, "examples", "greptile", "candidates.json"), "--results", gresults,
  ]);
  assert.equal(gg.status, 0, gg.stderr);
  assert.match(gg.stdout, /generate done: 2 ok, 0 failed, 0 skipped/);
  const gattempt = join(gresults, "synthetic-pr", "greptile-default", "rep-1");
  const gmeta = readMeta(gattempt);
  assert.equal(gmeta.status, "ok");
  assert.ok(!("reviewId" in gmeta), "no invented runId captured");
  assert.match(readFileSync(join(gattempt, "diff.patch"), "utf8"), /eval\(code\)/, "pinned diff saved");
  const gj = runCli(root, bin, [
    "grade", "--corpus", join(gfix, "corpus"), "--graders", join(REPO, "examples", "greptile", "graders.json"), "--results", gresults,
  ]);
  assert.equal(gj.status, 0, gj.stderr);
  assert.match(gj.stdout, /grade done: 2 ok, 0 failed, 0 skipped/);
  // the grader actually received the pinned diff (to judge unmatched findings)
  const ggrade = join(gattempt, "grades", "review-grader", "rev-1");
  assert.match(readFileSync(join(ggrade, "stdout"), "utf8"), /eval\(code\)/, "pinned diff reached the grader");
  const gt = runCli(root, bin, ["tabulate", "--results", gresults]);
  assert.equal(gt.status, 0, gt.stderr);
  assert.match(readFileSync(join(gresults, "tables.md"), "utf8"), /sql-injection/);
});

test("controlled agent dir: child runs a private snapshot copy; same-invocation source mutation cannot leak; drift rejected on rerun", (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);
  const corpus = writingCorpus(root);
  const agentDir = join(root, "agentdir");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), "MODELS-V1\n");
  writeFileSync(join(agentDir, "README.md"), "docs are ignored\n");
  const candidates = join(root, "candidates.json");
  writeJson(candidates, [
    { id: "mutator", argv: ["configprobe"], env: { PI_CODING_AGENT_DIR: agentDir, MUTATE_SOURCE: agentDir } },
    { id: "reader", argv: ["configprobe"], env: { PI_CODING_AGENT_DIR: agentDir } },
  ]);
  const results = join(root, "results");
  const args = ["generate", "--corpus", corpus, "--candidates", candidates, "--results", results];
  const r = runCli(root, bin, args);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /generate done: 4 ok, 0 failed, 0 skipped/);
  assert.equal(readFileSync(join(agentDir, "models.json"), "utf8"), "MODELS-V2-CHANGED\n", "the first arm really mutated the source mid-run");
  let sha = "";
  for (const caseId of ["hello", "bye"]) {
    for (const cand of ["mutator", "reader"]) {
      const dir = join(results, caseId, cand, "rep-1");
      assert.equal(readFileSync(join(dir, "stdout"), "utf8").trim(), "MODELS-V1", `${caseId}/${cand} executed the pre-run snapshot bytes, not the mutated source`);
      const input = JSON.parse(readFileSync(join(dir, "input.json"), "utf8"));
      assert.equal(input.agentConfig.dir, agentDir, "logical source recorded, not a random runtime path");
      assert.ok(!JSON.stringify(input).includes(".agent-run-"), "no ephemeral runtime path in the saved logical input");
      const meta = readMeta(dir);
      assert.equal(meta.env.PI_CODING_AGENT_DIR, agentDir, "recorded env keeps the logical source path");
      assert.ok(!readFileSync(join(dir, "meta.json"), "utf8").includes(".agent-run-"), "no ephemeral runtime path in meta.json");
      if (sha) assert.equal(input.agentConfig.sha256, sha, "all arms of one invocation share one config identity");
      sha = input.agentConfig.sha256;
    }
  }
  assert.equal(readMeta(join(results, "hello", "reader", "rep-1")).env.MUTATE_SOURCE, undefined, "undeclared env keys stay out of the record");
  // the archive holds exactly the validated bytes — nothing the child wrote
  const archive = join(results, ".agent-config", sha);
  assert.equal(readFileSync(join(archive, "models.json"), "utf8"), "MODELS-V1\n", "archive frozen at the pre-run bytes");
  assert.deepEqual(readdirSync(archive), ["models.json"], "no runtime state and no README in the immutable archive");
  assert.equal(
    readdirSync(results).filter((d) => d.startsWith(".agent-run-")).length,
    0,
    "private runtime dirs are removed after group cleanup",
  );
  // a later rerun under the same candidate ids with a changed config is
  // rejected, not mixed
  const r2 = runCli(root, bin, args);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /different saved inputs/);
  assert.ok(!existsSync(join(results, "hello", "reader", "rep-2")), "rejected rerun writes nothing");
});

test("controlled agent dir: credentials, symlinks, nesting and unexpected entries refused before any read/copy/spawn", (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);
  const corpus = writingCorpus(root);
  const goodDir = join(root, "good-agent");
  mkdirSync(goodDir);
  writeFileSync(join(goodDir, "models.json"), "{}\n");
  const outside = join(root, "outside-secret.json");
  writeFileSync(outside, "OUTSIDE-SECRET-DECOY\n");
  const badCases: Array<[string, string, (dir: string) => void, RegExp]> = [
    ["auth", "auth.json", (d) => writeFileSync(join(d, "auth.json"), "DECOY-NOT-A-REAL-TOKEN\n"), /"auth\.json"/],
    ["mcpauth", "mcp-auth.json", (d) => writeFileSync(join(d, "mcp-auth.json"), "DECOY-NOT-A-REAL-TOKEN\n"), /"mcp-auth\.json"/],
    ["symlink", "linked.json", (d) => symlinkSync(outside, join(d, "linked.json")), /"linked\.json" is a symlink/],
    ["dangling", "dangling.json", (d) => symlinkSync(join(root, "gone.json"), join(d, "dangling.json")), /"dangling\.json" is a symlink/],
    ["nesting", "sessions", (d) => mkdirSync(join(d, "sessions")), /"sessions" is not a plain file/],
    ["unexpected", "extra-notes.txt", (d) => writeFileSync(join(d, "extra-notes.txt"), "x\n"), /"extra-notes\.txt"/],
  ];
  for (const [name, entry, populate, pat] of badCases) {
    const bad = join(root, `bad-${name}`);
    mkdirSync(bad);
    writeFileSync(join(bad, "models.json"), "{}\n");
    populate(bad);
    // the bad dir belongs to the SECOND candidate: the refusal must still
    // precede EVERY spawn — the first candidate's config is fine
    const candidates = join(root, `cand-${name}.json`);
    writeJson(candidates, [
      { id: "first", argv: ["pi", "-p", "@{prompt}"], env: { PI_CODING_AGENT_DIR: goodDir } },
      { id: "second", argv: ["pi", "-p", "@{prompt}"], env: { PI_CODING_AGENT_DIR: bad } },
    ]);
    const results = join(root, `results-${name}`);
    const r = runCli(root, bin, ["generate", "--corpus", corpus, "--candidates", candidates, "--results", results]);
    assert.equal(r.status, 2, `${name}: ${r.stdout}`);
    assert.match(r.stderr, pat, name);
    assert.match(r.stderr, /examples\/pi-agent\/README\.md/, `${name}: actionable pointer`);
    assert.equal(r.trace(), "", `${name}: refused before ANY child was spawned`);
    const leaked = spawnSync("find", [results, "-name", entry], { encoding: "utf8" }).stdout.trim();
    assert.equal(leaked, "", `${name}: the refused entry was never copied into the results tree`);
    assert.equal(readFileSync(outside, "utf8"), "OUTSIDE-SECRET-DECOY\n");
    assert.ok(!r.stderr.includes("OUTSIDE-SECRET-DECOY"), "symlink target bytes never read");
  }
  // grader side: a refused grader config precedes any grader spawn
  const candidates2 = join(root, "cand-ok.json");
  writeJson(candidates2, [{ id: "alpha", argv: ["pi", "-p", "@{prompt}"] }]);
  const results2 = join(root, "results-g");
  const g0 = runCli(root, bin, ["generate", "--corpus", corpus, "--candidates", candidates2, "--results", results2]);
  assert.equal(g0.status, 0, g0.stderr);
  const badG = join(root, "bad-grader-dir");
  mkdirSync(badG);
  writeFileSync(join(badG, "auth.json"), "DECOY-NOT-A-REAL-TOKEN\n");
  const graders = join(root, "graders-bad.json");
  writeJson(graders, [{ id: "g", argv: ["grader", "@{output}"], env: { PI_CODING_AGENT_DIR: badG } }]);
  const rg = runCli(root, bin, ["grade", "--corpus", corpus, "--graders", graders, "--results", results2]);
  assert.equal(rg.status, 2);
  assert.match(rg.stderr, /"auth\.json"/);
  assert.equal(rg.trace(), g0.trace(), "no grader was spawned before the refusal");
});

test("grade: a bare @instruction file resolves from the grader cwd; @{configDir}/ stays config-relative", (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);
  const corpus = writingCorpus(root);
  const candidates = join(root, "candidates.json");
  writeJson(candidates, [{ id: "alpha", argv: ["pi", "-p", "@{prompt}"] }]);
  const results = join(root, "results");
  runCli(root, bin, ["generate", "--corpus", corpus, "--candidates", candidates, "--results", results]);
  writeFileSync(join(root, "note.md"), "CONFIG-DIR-INSTRUCTION\n");
  const sub = join(root, "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "note.md"), "CHILD-CWD-INSTRUCTION\n");
  const graders = join(root, "graders.json");
  writeJson(graders, [
    { id: "cwdfirst", argv: ["pi", "@note.md", "@{rubric}"], cwd: "sub" },
    { id: "cfg", argv: ["pi", "@{configDir}/note.md", "@{rubric}"] },
  ]);
  const r = runCli(root, bin, ["grade", "--corpus", corpus, "--graders", graders, "--results", results]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /grade done: 4 ok, 0 failed, 0 skipped/);
  const rev = (gid: string) => join(results, "hello", "alpha", "rep-1", "grades", gid, "rev-1");
  // the bare @note.md is the file the child would read: the one in its cwd
  const g = rev("cwdfirst");
  const gout = readFileSync(join(g, "stdout"), "utf8");
  assert.match(gout, /CHILD-CWD-INSTRUCTION/);
  assert.ok(!gout.includes("CONFIG-DIR-INSTRUCTION"), "the config-dir file must not shadow the child's cwd");
  assert.equal(readFileSync(join(g, "instructions", "0-note.md"), "utf8"), "CHILD-CWD-INSTRUCTION\n", "snapshot holds the cwd-relative bytes");
  const ginput = JSON.parse(readFileSync(join(g, "input.json"), "utf8"));
  assert.equal(ginput.protocol.instructions[0].sha256, sha256File(join(sub, "note.md")), "protocol identity tracks the executed bytes");
  // @{configDir}/note.md stays explicitly config-relative
  const gc = rev("cfg");
  assert.match(readFileSync(join(gc, "stdout"), "utf8"), /CONFIG-DIR-INSTRUCTION/);
  assert.equal(readFileSync(join(gc, "instructions", "0-note.md"), "utf8"), "CONFIG-DIR-INSTRUCTION\n");
});

test("grade: a final ```json opening truncated at EOF fails instead of reusing an earlier valid block", (t) => {
  const root = mkroot(t);
  const bin = stubBin(root);
  const corpus = writingCorpus(root);
  const candidates = join(root, "candidates.json");
  writeJson(candidates, [{ id: "alpha", argv: ["pi", "-p", "@{prompt}"] }]);
  const results = join(root, "results");
  runCli(root, bin, ["generate", "--corpus", corpus, "--candidates", candidates, "--results", results]);
  const graders = join(root, "graders.json");
  writeJson(graders, [
    { id: "eof", argv: ["eofjson", "@{output}"] },
    { id: "ok", argv: ["grader", "@{output}", "@{expectations}"] },
  ]);
  const r = runCli(root, bin, ["grade", "--corpus", corpus, "--graders", graders, "--results", results]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /grade done: 2 ok, 2 failed, 0 skipped/);
  const m = JSON.parse(readFileSync(join(results, "hello", "alpha", "rep-1", "grades", "eof", "rev-1", "meta.json"), "utf8"));
  assert.equal(m.status, "failed");
  assert.equal(m.reason, "unparseable");
  assert.match(m.message, /never closed/, "the truncated FINAL opening is the failing block — the earlier valid block is not a fallback");
  assert.ok(!existsSync(join(results, "hello", "alpha", "rep-1", "grades", "eof", "rev-1", "parsed.json")), "no stale scores recorded");
});
