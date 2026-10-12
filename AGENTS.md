# pawprint — working in this repo

Visiting to adopt a piece for your own pi? That's the README ("Adopt a
piece"). This file is for changing this repo.

- One worktree per change: `git -C ~/work/pawprint worktree add ~/work/pawprint-<branch> -b <branch> origin/main`;
  remove it after merge. `~/work/pawprint` is never edited; `~/.pi` is a plain runtime/config dir — managed
  config lands there only via `setup.sh --apply`, never by hand-editing managed files.
  Run `npm ci` in task worktrees, never in `~/work/pawprint` or `~/.pi`.
- The gate is `npm test`: `oxlint` (type-aware via tsgolint; no `any`, no floating/misused promises; opt out per line with a reason), `tsc`, then the node tests. Red = not done.
- Mise supplies Node 24. `npm ci` installs the pinned development tools and Pi SDK into this worktree's
  `node_modules`; `npm test` and `npm run typecheck` use them. Never `npx`.
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
