# pawprint — working in this repo

Visiting to adopt a piece for your own pi? That's the README ("Adopt a
piece"). This file is for changing this repo.

- Every pawprint change uses a fresh task worktree. Any full Pi session routes
  code changes of any size through fresh native herdr worktree → bounded main Coder
  (`launch_agent` role `managed-coder`) → worker and independent fresh review. Small fixes and renames are included. Only
  trivial configuration can bypass the code flow and use fixer; if unsure, use the full flow.
  Non-code authoring and small prose edits use the existing writer outside the code flow.
  Read-only work keeps its appropriate delegation.
  The recipe source is `agent/configs/managed-code-workflow.md`. When executing the flow,
  read the applied `<agent-dir>/configs/managed-code-workflow.md`: Pi's `getAgentDir()` uses
  nonempty `PI_CODING_AGENT_DIR` with Pi's path expansion, otherwise `~/.pi/agent`.
  Do not substitute repository source for a missing applied recipe. The recipe covers
  preflight, canonical repository/path/base checks, persistent parent identity,
  native launch/run/successor identities, acceptance, actor closure, claims, occupants,
  artifact preservation and authorized non-force cleanup. Pawprint's native creation is
  `herdr worktree create --cwd /Users/pantera/work/pawprint --branch <branch> --base origin/main --path /Users/pantera/work/pawprint-<branch> --label <branch> --no-focus`.
  Delegate at the actual verified returned path. A Coordinator owns a broad project;
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
  Delegated full sessions publish or deploy only when assigned in their scoped handoff
  under applicable owner authorization; otherwise return evidence for launching-parent acceptance.
  Already assigned and authorized actions do not need repeat approval prompts.
  Original parent-saved native receipts and owned run/continuation/command records
  are authoritative for cleanup. Cross-check the task-local plan against those originals;
  child-editable plans cannot replace or overwrite identity or actor evidence.
  Ordinary Intercom carries decisions to that parent; no answer blocks dependent work.
  Full workstream owners relay required owner questions explicitly. No durable question ledger.
  Headless delegates use prompt/name/cwd/model/context, explicit qualified models and
  inherited thinking. Role contracts are in the prompt, not loaded profiles.
  Only trivial configuration or non-code work outside the code flow can use direct
  `git -C ~/work/pawprint worktree add ~/work/pawprint-<branch> -b <branch> origin/main`.
  Authorized direct-tree cleanup uses `git -C ~/work/pawprint worktree remove ~/work/pawprint-<branch>`
  after the same actor/decision/claim/occupant/artifact checks in the shared recipe.
  Native cleanup also requires its fresh exact workspace identity check.
  Never force or auto-remove. Preserve needed ignored artifacts before removal.
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
- Mise supplies Node 24. `npm ci` installs the pinned development tools and Pi SDK into this worktree's
  `node_modules`; `npm test` and `npm run typecheck` use them. Never `npx`.
  Resolve the pinned runtime before applying test-only `HOME`/`TMPDIR` overrides so tool setup does not
  relocate or reinstall it inside the fixture. Keep test `TMPDIR` short enough for Unix socket filenames
  to fit platform path limits.
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
  Copy an existing suite. Red first.
- Deploy is the owner's agent's, not yours: PR, `reviewer` clean, report.
  For read-only reviews, consume saved run results instead of asking reviewers to write report files.
  A status update names the actual stage of each item — running, queued or blocked — plus the
  next action and its owner, and the blocker when there is one. Handoff and briefing time is
  not "checks"; a queued review is not running. When explaining a delay, separate execution
  time from handoff and waiting.
