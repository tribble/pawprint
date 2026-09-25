# pawprint — working in this repo

Visiting to adopt a piece for your own pi? That's the README ("Adopt a
piece"). This file is for changing this repo.

- One worktree per change: `git -C ~/work/pawprint worktree add ~/work/pawprint-<branch> -b <branch> origin/main`;
  remove it after merge. `~/work/pawprint` and `~/.pi` are never edited; nothing is ever `npm install`ed here or in `~/.pi`.
- The gate is `npm test`: `biome lint` (no `any`; opt out per line with a reason), `tsc`, then the node tests. Red = not done.
- Toolchain is mise: `tsc`, `node`, `pi` come from it. Never `npx`. Pi's install is
  `$(mise where npm:@earendil-works/pi-coding-agent)/node_modules/@earendil-works/pi-coding-agent` — its `docs/` and `dist/`
  are there; read them instead of guessing pi's behaviour.
- Pi types resolve through `.pi-types`, a symlink to the mise-installed Pi package store. Missing or stale →
  `npm run types`.
- This repo *is* the package: source string `git:github.com/tribble/pawprint`, clone
  `~/.pi/agent/git/github.com/tribble/pawprint`. Hardcode these; never discover them.
- `agent/` is the owner's live config (`~/.pi` is a sparse worktree of it); `manifest.json` `files[]`
  (agent-dir-relative) must equal the tracked `agent/` files — `git ls-files agent/ | sed 's#^agent/##'`
  (`scripts/validate.sh` checks). Extensions/skills/prompts/themes live at the repo root and ship as the package.
- Tests: `tests/harness.mjs` fakes the extension API and `pi.exec`; fixture repos come from `tests/fixture.ts`.
  Copy an existing suite. Red first.
- Deploy is the owner's agent's, not yours: PR, `reviewer` clean, report.
