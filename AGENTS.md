# pawprint — working in this repo

Visiting to adopt a piece for your own pi? That's the README ("Adopt a
piece"). This file is for changing this repo.

- Every pawprint change uses a fresh task worktree. Any full Pi session routes
  code changes of any size through fresh native herdr worktree → bounded Delivery Lead
  (`launch_agent` role `delivery-lead`) → worker and independent fresh review. Small fixes and renames are included. Only
  trivial configuration can bypass the code flow and use fixer; if unsure, use the full flow.
  Adopting an already reviewed and tested immutable dependency revision, with its aligned
  prose, is trivial configuration when it needs no consuming-repo code change, migration or
  unresolved compatibility work: fixer/writer plus independent review, and this repo's
  required checks still run. Unqualified dependency upgrades stay in the code flow.
  An owner-authorized personal-environment rollout does not wait on upstream merge, release
  or hosted-only CI; this repo's required checks and pin verification still gate it.
  Non-code authoring and small prose edits use the existing writer outside the code flow.
  Read-only work keeps its appropriate delegation.
  The recipe source is `agent/configs/managed-code-workflow.md`. When executing the flow,
  read the applied `<agent-dir>/configs/managed-code-workflow.md`: Pi's `getAgentDir()` uses
  nonempty `PI_CODING_AGENT_DIR` with Pi's path expansion, otherwise `~/.pi/agent`.
  Do not substitute repository source for a missing applied recipe. The recipe covers
  preflight, canonical repository/path/base checks, persistent parent identity,
  native launch/session/file/pane identities, acceptance, actor closure, claims, occupants,
  artifact preservation and authorized non-force cleanup. Pawprint's native creation is
  `herdr worktree create --cwd /Users/pantera/work/pawprint --branch <branch> --base origin/main --path /Users/pantera/work/pawprint-worktrees/<branch> --label <branch> --no-focus`.
  New pawprint task worktrees group under `~/work/pawprint-worktrees/<branch>`; the main checkout stays `~/work/pawprint`.
  Existing worktrees stay where they are; cleanup follows each tree's recorded actual path.
  Delegate at the actual verified returned path. A responsive Coordinator owns a broad project and launches multiple concurrent independent
  Delivery Leads. Each Delivery Lead supervises sequential native workers and fresh reviewers.
  Neither main writes code; the Delivery Lead triggers review, mediates and returns valid fixes. A Coordinator owns a broad project;
  additional full sessions own substantial independent scope across deliveries,
  not routine per-PR wrappers. Every full session uses the same code flow.
  Before implementation, settle the short path to real acceptance: which checks run
  before merge, which proof only exists after deploy, and every runtime, authentication,
  restart or shared-install step with who handles it. Discovery may be needed to find
  them. Put them in the brief, not after the review passes.
  Existing managed participants execute their assigned roles without recursive wrapping.
  Leaves and narrowly scoped agents receiving code outside this flow stop and ask a
  capable parent for routing. Never create a tree through shell, raise depth or edit inline to bypass it.
  There is no legacy pane-Coder exception. A claimed or narrowly assigned pane tree
  cannot become a managed tree. Escalate an assignment that cannot enter the flow
  within its authority and scope to its launching parent. Do not bypass claims or
  create an unauthorized second scope. Existing pane APIs and legacy claims stay intact.
  The launching parent owns final acceptance, authorized publication and native lifecycle.
  Before declaring a task complete, the parent accounts for every agent it itself launched for
  that task, including superseded implementers and diagnostic helpers, and shuts each down once
  its children and commands have verifiably exited. Preserving a worktree or evidence never
  requires keeping its agent alive. Authorized worktree and branch cleanup is part of the
  delivery: a task is not "done" while it is pending, and a partial completion names
  exactly what remains and who owns it.
  Delegated full sessions publish or deploy only when assigned in their scoped handoff
  under applicable owner authorization; otherwise return evidence for launching-parent acceptance.
  Already assigned and authorized actions do not need repeat approval prompts.
  Original parent-saved native receipts and owned run/continuation/command records
  are authoritative for cleanup. Cross-check the task-local plan against those originals;
  child-editable plans cannot replace or overwrite identity or actor evidence.
  Reconcile missing PIDs or exit codes against the original command/result evidence and
  execution semantics before declaring cleanup blocked. Preserve genuinely unknown values;
  foreground closure proves nothing about detached descendants. Capture each command's
  failure so a later success cannot mask it.
  Ordinary Intercom carries decisions to that parent; no answer blocks dependent work.
  Full workstream owners relay required owner questions explicitly. No durable question ledger.
  Native leaves use `launch_agent({name,role,cwd,task})`. Role profiles supply qualified models,
  explicit native efforts and complete contracts in the actual prompt. Herdr owns lifecycle;
  standalone pi-intercom owns messaging. See `agent/configs/delegation.md`.
  Only trivial configuration or non-code work outside the code flow can use direct
  `git -C ~/work/pawprint worktree add ~/work/pawprint-worktrees/<branch> -b <branch> origin/main`.
  Authorized direct-tree cleanup uses `git -C ~/work/pawprint worktree remove <recorded tree path>`
  (`~/work/pawprint-worktrees/<branch>` for trees created under this convention)
  after the same actor/decision/claim/occupant/artifact checks in the shared recipe.
  Native cleanup also requires its fresh exact workspace identity check.
  An unexpected occupant is a reason to investigate before reporting cleanup blocked:
  inspect its live process identity, the native creation/event records and configured
  lifecycle hooks, since hook-created companions can follow the creation receipt and be
  absent from it. Ownership still needs authoritative evidence, never a name or workspace
  membership; anything unresolved stays preserved.
  Never force or auto-remove. Before removal, copy needed ignored artifacts outside the
  trees being removed and verify the copy by hash.
  After verified merge and successful verified tree removal, the parent deletes the
  delivery's merged local and remote task branch as part of the authorized delivery;
  no separate approval is needed. Follow the recipe's merged-branch deletion steps:
  exact recorded merged head, `branch -d` first, `-D` only for missing squash/rebase
  ancestry, fresh `ls-remote` equality before `push origin --delete`. Keep
  abandoned/unmerged branches unless separately authorized.
  Keep `~/work/pawprint` attached to `main`; never detach it or author changes there.
  Routine deploy must verify `symbolic-ref --quiet HEAD` is `refs/heads/main`
  before fetch, fast-forward-only merge or apply. A failed check stops deployment;
  do not switch branches automatically. Author only in fresh task worktrees.
  `~/.pi` is a plain runtime/config dir — managed
  config lands there only via `setup.sh --apply`, never by hand-editing managed files.
  Run `npm ci` in task worktrees, never in `~/work/pawprint` or `~/.pi`.
- The gate is `npm test`: `oxlint` (type-aware via tsgolint; no `any`, no floating/misused promises; opt out per line with a reason), `tsc`, then the node tests. Red = not done.
  Under process limits, count the runner, test-file processes and nested helpers. Run the same pinned components
  sequentially with `--test-concurrency=1` for Node tests.
  Preserve every test file, the register import, all enabled tests, component order and fail-fast behavior.
  Record actual commands; do not call an equivalent serial gate a literal `npm test` run.
  A passing run stands while the relevant code, toolchain, configuration and state are
  unchanged. Do not hand off solely to rerun such a command or repackage its evidence.
  Independent and specialist checks keep their own actor. Integrate known relevant
  merged changes before the final review so it sees the real integration state, and do not
  restart checks or reviews for unrelated churn.
  Before optimizing the gate, time the full run at normal concurrency and find its critical path:
  per-file durations do not sum to wall time. Delete needless test work before adding concurrency
  machinery. Compare before/after on one base and runtime, excluding install time, and report
  per-file gains separately from full-gate wall time. Keep coverage and runner settings intact.
- Mise supplies Node 26. `npm ci` installs the pinned development tools and Pi SDK into this worktree's
  `node_modules`; `npm test` and `npm run typecheck` use them. Never `npx`.
  Resolve the pinned runtime before applying test-only `HOME`/`TMPDIR` overrides so tool setup does not
  relocate or reinstall it inside the fixture. Keep test `TMPDIR` short enough for Unix socket filenames
  to fit platform path limits.
  Isolate dependency resolution too, not only `HOME` and caches: install probes run in a clean
  tree with no ancestor `node_modules`. Compare installation layouts with identical runtime,
  package scripts and configuration.
  Read `node_modules/@earendil-works/pi-coding-agent/docs/` and `dist/` instead of guessing Pi's behaviour.
  Keep host-provided packages in optional runtime peers and development dependencies, not `dependencies`.
- This repo *is* the package: source string `git:github.com/tribble/pawprint`, clone
  `~/.pi/agent/git/github.com/tribble/pawprint`. Hardcode these; never discover them.
- `agent/` is the source of the owner's live config: `setup.sh --apply` applies it to the plain `~/.pi/agent`
  (source-only files copy; `settings.json`/`mcp.json` merge field-aware, runtime/unmanaged live values survive),
  then on the default target installs every package the applied `settings.json` declares (native `pi install`,
  first failure exits nonzero with the config applied; `--dry-run`/`--config-only`/alternate targets skip installs).
  `manifest.json` `files[]` (agent-dir-relative) must equal the tracked `agent/` files —
  `git ls-files agent/ | sed 's#^agent/##'` (`scripts/validate.sh` checks).
  Extensions/skills/prompts/themes live at the repo root and ship as the package.
- Tests: `tests/harness.mjs` fakes the extension API and `pi.exec`; fixture repos come from `tests/fixture.ts`.
  Copy the suite whose contract matches, with the least-integrated fixture that proves it:
  plain files for file/config cases, controlled inputs at an existing boundary for pure decisions,
  real Git or processes only for integration contracts. Refusal tests stay isolated from the real
  checkout even when the guard under test fails. Red first.
- Deploy is the owner's agent's, not yours: PR, `reviewer` clean, report.
  For read-only reviews, consume saved run results instead of asking reviewers to write report files.
  A status update names the actual stage of each item — running, queued or blocked — plus the
  next action and its owner, and the blocker when there is one. Handoff and briefing time is
  not "checks"; a queued review is not running. When explaining a delay, separate execution
  time from handoff and waiting.
