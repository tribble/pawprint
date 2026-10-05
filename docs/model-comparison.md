# Model comparison runner

Five-stage file-based CLI for comparing command-line candidates (a fresh pi
agent, Greptile review, anything spawnable) on a fixed corpus. Node stdlib
only; candidates are argv arrays, not plugins. Each stage reads only saved
artifacts of the earlier ones, so grading, tabulation, and re-analysis never
re-run candidates.

```
node scripts/compare.ts generate  --corpus DIR --candidates FILE --results DIR [--reps N] [--timeout-ms N]
node scripts/compare.ts grade     --corpus DIR --graders FILE --results DIR [--timeout-ms N]
node scripts/compare.ts tabulate  --results DIR
node scripts/compare.ts blind     --results DIR [--seed S]
node scripts/compare.ts summarize --results DIR --cmd FILE [--timeout-ms N]
```

**Point --results at an ignored scratch dir.** This repo's .gitignore is
default-deny, so any non-allowlisted directory works (`notes/` is ignored).
The tracked paths are `docs/`, `tests/`, `examples/`, `scripts/`,
`extensions/`, `agent/` and root files — never put private run output there;
run outputs can contain the reviewed code. Raw child stdout/stderr are saved
verbatim; a command that echoes a token into its own output persists it in the
results tree.

## Stage 1 — corpus

A corpus dir holds `cases.json` plus prompt files:

```json
[{
  "id": "F1-nest",
  "promptFile": "prompt.md",          // prompt cases
  "expectations": "what a good answer must do",
  "rubric": {"answer-first": 2, "facts": 2},
  "repo": "/abs/checkout", "base": "<full-sha>", "replay": "<full-sha>"   // review cases
}]
```

- `id` becomes a directory name (`[A-Za-z0-9._-]+`). Duplicate case,
  candidate, or grader ids are a config error — results are keyed by id and a
  duplicate would silently mix two data sets.
- `rubric` is **required**: the fixed criteria and scale for this case. Every
  grade of the case must score exactly these criteria, each an integer in
  `0..max`; anything else is a failed grade, so totals in one table are always
  totals on the same instrument.
- Expectations and the rubric are grader-only. Candidate argv has no
  `{expectations}`/`{rubric}` placeholder — using one there is a config error
  — and neither is written into the candidate-visible `input.json`.
- Review cases pin one base→replay pair per PR, as **full commit SHAs** — a
  moving ref (`HEAD`, a branch) is rejected at load. You prepare the checkout
  at the replay SHA. The runner verifies the directory the candidate actually
  runs in (its configured `cwd`, or the directory you launched from): HEAD ==
  replay, worktree clean, `git merge-base --is-ancestor base replay` (Greptile
  reviews merge-base→HEAD, so the diff equals the pinned one only then). It
  never fetches, switches, or cleans.

## Stage 2 — generate

candidates.json: `[{"id": "fable", "argv": ["pi", "-p", "@{prompt}"], "cwd?": ".", "env?": {"PI_CODING_AGENT_DIR": "{configDir}/../pi-agent"}}]`

Placeholders: `{prompt}` (abs path to the case's **frozen** prompt — see
below), `{repo}` `{base}` `{replay}` (review cases), `{configDir}` (dir of
the candidates file). Relative `cwd` resolves against the candidates file's
directory. Any `{name}`-shaped token that is not a known placeholder is a
config error. Optional `env` entries are substituted the same way, merged
over the process environment, and recorded in the saved `meta.json` — declare
only non-secret values (credentials stay in the real environment, inherited
and never written to disk).

**Frozen case input.** Before any candidate of a case runs, the runner writes
`<case>/case-input.json` (prompt sha256, promptFile, pinned repo/base/replay)
and `<case>/prompt.md` (the exact prompt bytes). Candidates are fed those
frozen bytes, not the mutable corpus file, so every candidate arm answers the
same input — including arms added by a later invocation. Any later change to
the case input (prompt bytes, promptFile, or the pinned review pair) is
rejected at the case level, before any candidate is even considered, no
matter which candidate ids the new invocation touches. Use a fresh
`--results` directory for changed inputs.

Runs are sequential: every case × candidate × rep, one at a time. Each attempt
lands in `<results>/<case>/<candidate>/rep-N/` with `meta.json` (resolved
argv, cwd, declared env, timing, exit code, status), `stdout`, `stderr`,
`input.json` (candidate-visible case + candidate config only), `prompt.md`
(copy of the frozen case prompt), and for review cases `diff.patch` (the
pinned base→replay diff, snapshotted before the candidate runs).

- **Frozen attempts.** An existing attempt dir is never overwritten. On a
  rerun the runner compares each existing attempt's saved inputs (config,
  frozen prompt bytes, resolved argv/cwd, controlled-config hash) with the
  current ones and **refuses to run** when they differ. Extending `--reps`
  with unchanged inputs is fine.
- Failures (nonzero exit, timeout, signal, missing executable, guard, argv
  over 800 bytes) are saved results, not errors: generate exits 0 and they
  appear in the tables' Failures list. A run killed mid-spawn leaves a dir
  with partial `stdout`/`stderr` but no `meta.json` (written last) and shows
  as `interrupted`.
- **Timeouts bound the whole process group, and group cleanup finishes before
  the verdict.** Children run as process-group leaders; on timeout the runner
  SIGTERMs the group, then SIGKILLs after a 2s grace window — and the same
  TERM→probe→KILL escalation runs when a leader exits early (normally or on
  the timeout TERM) while a helper that ignores SIGTERM lives on. The verdict
  is written only after the group is gone or SIGKILL delivered, so nothing
  keeps spending past it. Streams go straight to files, so interrupting the
  runner (Ctrl-C also kills the child's group) never loses already-emitted
  output.
- Every argv element must stay ≤ 800 bytes — longer ones get SIGKILLed on
  this machine with no log. Pass long text via files (`@file` for pi);
  `greptile --instructions` has no file form, keep it short.
- A missing executable is an actionable saved failure, never auto-installed.

## Stage 3 — grade

graders.json: same shape as candidates (argv/cwd/env); placeholders `{output}`
(the saved answer), `{expectations}`, `{rubric}` (fixed rubric), `{prompt}`,
`{diff}` (review cases: the pinned diff), `{configDir}`. Graders run only
over successful saved attempts — regrading never re-runs candidates. Grader
`cwd` is honored (relative to the graders file).

**Instruction files are inputs, executed from snapshots.** A grader argv
`@file` token that names an existing file and carries no runner placeholder
(e.g. `@{configDir}/grader-prompt.md`) is a declared model input: its exact
bytes are copied into the grade revision (`instructions/<i>-<name>`), the
grader is pointed at the snapshot, and the bytes' sha256 is part of the
grading protocol. A bare `@file` resolves against the grader's effective
cwd — the directory the child would read it from; `@{configDir}/...` is the
explicit config-relative form. Executable argv entries (argv[0], scripts with
relative imports) are never relocated.

**Blind grading inputs.** Each grade stages its inputs into its own unique
`mkdtemp` directory under `<results>/.grading-XXXXXX` — neutral paths that
carry no candidate identity (pi shows the model each `@file`'s absolute name,
so this matters) and are never shared with another grade. The staging dir is
removed when the grade finishes; the canonical copies live beside the grade.

**Revisions are grading-protocol revisions.** The protocol is the grader's
command/settings (argv, cwd, declared env, controlled pi config hash), the
case's fixed rubric, the expectations, and the exact instruction bytes. Each
grade lands in `grades/<grader>/rev-N/`. Regrading with an identical protocol
skips. **Any** protocol change — edited grader instructions, a changed flag,
a changed rubric or expectation — gets a **new** revision with the new inputs
materialized; it never silently skips. Earlier revisions and their raw
outputs are never erased. An interrupted grade (rev dir without `meta.json`)
is retried as a new revision and reported in the tables. To redo a completed
grade, delete its rev dir. The answer being graded is deliberately not part
of the protocol: different answers under one protocol stay comparable.

Each revision saves `answer`, `prompt.md`, `expectations.md`, `rubric.md`,
`diff.patch` (whichever exist), `instructions/` (exact instruction bytes),
`input.json` (full protocol, source attempt, controlled-config hash, sha256
of every file referenced on the resolved argv), raw `stdout`/`stderr`,
`parsed.json`, and `meta.json` (resolved argv, cwd, timing, status) — enough
to identify exactly which model/settings/prompt produced a score.

Grader contract: the FINAL ```json opening of stdout — and only it — must be
matched by its own closing fence and parse to `{"criteria": {<exactly the
rubric's keys>: <integer in scale>}, "notes"?}`. A valid earlier block
followed by a malformed or unterminated final one is a failed grade, not a
score. Raw grader output is kept either way. Use one grader per model family
(see `examples/writing/graders.json`) and treat disagreement as data, not
noise to average away.

## Stage 4 — tabulate

Pure re-render: reads saved grades, writes `tables.md` + `tables.json`.
Identical saved inputs → identical bytes; it spawns nothing. Per case, one
table per grader (criteria columns + `Total (max N)`), grader notes, then a
Failures list (interrupted attempts and grades, failed attempts and grades,
corrupt grade files). If a case's grades under one grader span a protocol
change, each protocol gets its own table, marked as not comparable —
re-tabulation never mixes protocol versions into one Total column.
Model-written text (criteria notes) is escaped before it can forge table rows
or sections.

## Stage 5 — blind + summarize

`blind` writes `blind.md` (successful outputs per case, labeled Sample A/B/…
from `--seed`, no identities, no expectations, each sample indented so
model-written markdown cannot forge sample boundaries) and `blind-key.json`.
**Blinding is honor-system**: labels are reproducible from the seed and the
key sits beside the file — it hides identities from a cooperative reader who
keeps the key closed, not from an adversary. The human read is the
tie-breaker when graders disagree.

`summarize` runs one command (`--cmd` file: `{"argv": [...], "cwd"?,
"env"?}`) with `{tables}` and `{blind}` placeholders. It snapshots `tables.md`
(and `blind.md` when present) **before** spawning and passes those snapshots
(`summary-attempt-tables.md`, `summary-attempt-blind.md`), so the narrative
provably summarizes the bytes recorded with it even if the live files change
mid-run. On success it writes `summary.md`, `summary.meta.json` (sha256 of
the exact pre-spawn input bytes), `summary-tables.md`, and
`summary-blind.md`. On failure the previous successful summary is preserved
untouched; the failed attempt's raw output lands in
`summary-attempt.md`/`.stderr` and its metadata in
`summary-failed.meta.json`. The summary is interpretive; the tables stay the
source of truth.

## Examples

- `examples/writing/` — the eight writing cases from docs/writing-density
  (prompts referenced in place, expectations distilled from the original
  score sheets, the rubric the sheets actually used: `answer-first`,
  `writer-protection`, `required-facts`, `readability`, each 0..2), two pi
  candidates, two grader families, summarizer. Live runs spend model tokens:
  ```
  node scripts/compare.ts generate --corpus examples/writing --candidates examples/writing/candidates.json --results notes/demo-writing --reps 2
  node scripts/compare.ts grade --corpus examples/writing --graders examples/writing/graders.json --results notes/demo-writing
  node scripts/compare.ts tabulate --results notes/demo-writing
  node scripts/compare.ts blind --results notes/demo-writing --seed pick-one
  node scripts/compare.ts summarize --results notes/demo-writing --cmd examples/writing/summarizer.json
  ```
- `examples/greptile/` — portable synthetic review case. `make-fixture.sh
  <workdir>` builds a two-commit repo (base + replay with two planted bugs,
  fixed dates → stable SHAs) and a corpus wired to it. **The fixture is
  offline-only**: it has no git remote, so the real Greptile CLI's preflight
  rejects it. Use it with stub executables, as `tests/compare.test.ts` does.

### Controlled pi invocation

Every pi invocation in the shipped examples (candidates, graders, summarizer)
declares `PI_CODING_AGENT_DIR` as the committed `examples/pi-agent/`
directory plus `--no-approve`, on top of `--no-tools/--no-extensions/
--no-skills/--no-prompt-templates/--no-context-files/--no-session`. Verified
against the installed pi: the agent-dir override replaces the ambient
`~/.pi/agent` (models.json, skills, MCP servers, custom tools), and
`--no-approve` additionally drops project-local `.pi/` settings and
SYSTEM.md/APPEND_SYSTEM.md from the working directory. The declared dir is
validated before anything is read, copied, or spawned: only `models.json`,
`settings.json`, `SYSTEM.md` and `APPEND_SYSTEM.md` may be present (README.md
is ignored); credentials, runtime state, symlinks and subdirectories are
refused with a pointer at `examples/pi-agent/README.md`. Once per invocation
the runner snapshots those bytes into `<results>/.agent-config/<sha256>/`
(non-secret bytes only — credentials come from the runtime environment and
are never written to disk). No child executes the source dir or the archive:
each child runs against a private per-process copy, removed when the child
finishes (pi writes runtime state into its agent dir, and the archive must
stay byte-frozen). The snapshot hash is part of the attempt input and the
grading protocol: a changed config under an existing candidate id is rejected
on rerun, and editing the controlled config deliberately starts a new
revision. What
remains ambient, honestly: pi's built-in default system prompt (fixed per
installed pi version, identical for every candidate), the installed pi
version itself, and provider credentials/ids from the caller's environment.
Corpus-only reproducibility is therefore not claimed — same machine, same pi
install, same caller credentials is the controlled unit. See
`examples/pi-agent/README.md`.

### Live Greptile

Verified against the installed 3.6.1 bundle (offline source read). A live
`greptile review -b <base> --json` requires, as preflight: the candidate runs
inside a git work tree on a **named branch** (detached HEAD is rejected) whose
HEAD is the pinned replay SHA, with a **configured remote** for a repository
enabled in your Greptile org, and credentials in the environment. `-b` accepts
a full base SHA (resolved via `rev-parse --verify`). The runner never creates
remotes, switches branches, or publishes anything — prepare all of that
yourself. A live run uploads the diff and spends credits. The JSON renderer
emits `{summary, confidence, confidenceReasoning, securitySummary,
instructions, comments[]}` — no run id; interrupted live reviews are retried
via the CLI's own `greptile review show <UUID> --json`.

## Limitations

- Sequential only, no scheduling, no resume beyond delete-the-dir retry.
- If the runner itself is SIGKILLed (or the machine dies) mid-spawn, its
  cleanup never runs: the child's process group can outlive it. The runner
  can't fix that — check for strays after a hard kill (`ps -o pgid`).
  Ctrl-C/SIGTERM is gentler but not clean: the handler SIGKILLs the active
  child group, then `process.exit` skips the `finally` cleanup, leaving
  `.agent-run-*` and `.grading-*` scratch dirs behind. Those dirs can hold
  partial state a child wrote — confirm the processes are gone (`ps -o pgid`)
  before deleting them.
- Child stdout/stderr are written to disk unbounded — a child that prints
  forever will fill the disk. Bound it with `--timeout-ms`.
- Declared `env` values land in saved `meta.json`/`input.json`: use them for
  non-secret config (PI_CODING_AGENT_DIR and the like), never credentials.
- Greptile's server-side context (org settings, repo index, memory) is
  outside our control: record known settings with the run and treat a review
  of an old SHA as potentially informed by the current indexed graph. That is
  a provider question, disclosed here rather than assumed away.
- Expected findings for review cases are a baseline, not exhaustive;
  unmatched findings need judgment against the pinned diff (the grader gets
  the diff). No line-overlap matching is implemented as proof of bug identity.
- Pass/fail comes from exit codes; for pi that means `-p` print mode (a
  final error/aborted exits nonzero). `--mode json` event streams are not
  parsed in this slice, and pi print mode retains no usage/cost metadata.
- Grading blindness is honor-system (above); a deliberately adversarial setup
  is out of scope for this local tool.
