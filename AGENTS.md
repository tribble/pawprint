# pawprint — working in this repo

Visiting to adopt a piece for your own pi? That's the README ("Adopt a
piece"). This file is for changing this repo.

- Every pawprint change uses a fresh task worktree. Direct worker/fixer/manual paths use
  `git -C ~/work/pawprint worktree add ~/work/pawprint-<branch> -b <branch> origin/main`.
  Coordinator-led PR work uses
  `herdr worktree create --cwd /Users/pantera/work/pawprint --branch <branch> --base origin/main --path /Users/pantera/work/pawprint-<branch> --label <branch> --no-focus`,
  then managed `delegate` at the actual returned path. Follow
  `agent/configs/session-role-coordinator.md` for preflight, identity checks and run tracking.
  Preserve legacy/uncertain pawprint claims. Never attach another workstream or pane Coder to a managed tree.
  Only the authorized Coordinator removes it with `herdr worktree remove --workspace <returned workspace_id>`.
  Require merge/authorized abandonment, every recorded task agent/command finished and no pending decision.
  Just before native removal, freshly match the exact recorded workspace ID to recorded canonical `checkout_path`/`repo_key`/`is_linked_worktree: true`.
  Inspect the Git admin dir for `pawprint-writer.json` or `pawprint-writer.lock` and canonical visible herdr agent
  `cwd`/`foreground_cwd` occupants. Any claim/lock/occupant, mismatch or unknown inspection means keep the tree.
  If a visible agent path no longer exists, canonicalize its existing parent and use `lstat` to prove the final
  entry absent (not a dangling symlink). Compare canonical-parent-plus-final-name against the canonical task tree:
  known absence outside that tree is not an occupant. Missing ancestors, unresolved links,
  permission errors or unknown identity still block. Actor completion, claims and deletion authority
  remain independent requirements.
  Herdr does not account for detached headless writers. Keep unknown/running actors' trees; never force or auto-remove.
  Non-force removal deletes ignored files too; preserve needed artifacts first. Authorized direct-tree cleanup uses
  `git -C ~/work/pawprint worktree remove ~/work/pawprint-<branch>` after the same actor/claim/artifact checks.
  Only after verified merge and successful verified removal, explicit branch deletion authority permits
  `git -C ~/work/pawprint branch -d <branch>`. Keep abandoned/unmerged branches unless separately authorized.
  Explicit pane APIs remain unchanged. `~/work/pawprint` is never edited; `~/.pi` is a plain runtime/config dir — managed
  config lands there only via `setup.sh --apply`, never by hand-editing managed files.
  Run `npm ci` in task worktrees, never in `~/work/pawprint` or `~/.pi`.
- The gate is `npm test`: `oxlint` (type-aware via tsgolint; no `any`, no floating/misused promises; opt out per line with a reason), `tsc`, then the node tests. Red = not done.
  Under process limits, count the runner, test-file processes and nested helpers. Run the same pinned components
  sequentially with `--test-concurrency=1` for Node tests.
  Preserve every test file, the register import, all enabled tests, component order and fail-fast behavior.
  Record actual commands; do not call an equivalent serial gate a literal `npm test` run.
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
