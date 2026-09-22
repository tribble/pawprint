# pawprint

The curated print of my pi agent config, in two halves. The repo root is a
**pi package** (`package.json` → `pi` manifest): `extensions/`, `skills/`,
`prompts/`, `themes/` — code pi loads from a package, installed with
`pi install git:github.com/tribble/pawprint` (floating `main`;
`pi update --extensions` pulls). `agent/` mirrors `~/.pi/agent`-relative paths and holds exactly the
reviewed-safe *config* files; on my machine `~/.pi` **is a sparse worktree of
this repo** (cone: `agent/`), so the live config is the checkout itself. The default-deny `.gitignore` is what keeps `auth.json`, OAuth
state, sessions and package clones out: nothing under `agent/` is tracked
unless its directory is allowlisted. **`manifest.json` is the adopters'
catalog**: its `files` list (agent-dir-relative) must equal the tracked
`agent/` files (`validate.sh` checks), plus `tools` (PATH audit) and `env`
(presence audit). Adopters get pieces by **copying** (`--only`) — never
symlinks: a tool writing its config through a symlink would write into this
repo.

There is deliberately no prompt-driven `/setup` installer: determinism beats
adaptivity for a single-owner print.

## Adopt a piece

The package half: `pi install git:github.com/tribble/pawprint`, then
`pi config` to disable the extensions you don't want (or list the ones you do
under the package entry in `settings.json`). Each extension's header comment
says what it does and what it needs (`herdr`, `pr-watch`, …).

The config half is one person's choices, but pieces of it stand alone. The catalog
is `manifest.json`'s `about` map — one entry per shipped file: what it does,
what it needs, and `personal: true` where it encodes my own choices (models,
gateway, rules) rather than something to copy blind. A bare `./setup.sh`
(no `--all`, no `--only`) refuses to run and prints these three commands, so
a visitor cannot imprint the whole thing by accident.

```sh
./setup.sh --list                              # catalog — table on a TTY, JSON [{path, does, needs, personal}] when piped
./setup.sh --dry-run --only cloak.json         # plan only
./setup.sh --only cloak.json                   # copy just that (same backup rules; no machinery)
```

A pi agent that `cd`s into a checkout gets the same instructions from the
root `AGENTS.md`.

## Fresh machine (mine)

This is how *I* set up a new machine; if you are not me, you want "Adopt a
piece" above.

```sh
git clone git@github.com:tribble/pawprint.git ~/work/pawprint
~/work/pawprint/setup.sh --all
```

`setup.sh --all` makes `~/.pi` a **locked sparse worktree on `main`** of the
clone (cone `agent/` + `.githooks/`; root files come along), detaching the
clone from `main` since a branch checks out once. An existing `~/.pi/agent` is
adopted in place: equal files are left alone, missing ones checked out, a
differing one is `DRIFT` — nothing is overwritten and the run stops until it
is resolved with git in `~/.pi`. Re-runs fast-forward to `origin/main`, refusing
when an incoming new file would land on something already live. `--dry-run`
prints the plan and writes nothing; `--config-only` skips the machine machinery.

The machine machinery (skipped under `--dry-run` / `--config-only` /
non-default target) then bootstraps the rest: pi + agent-browser via npm,
mise toolchain pin, `.pi-types` symlink, packages from the
`agent/settings.json` manifest, ghostty config copy-out, gh-dash
extension. Prereq: `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_GATEWAY_ID` set in
`~/.config/fish/conf.d` (see the dotfiles repo's `pi.fish.template`).

Manual steps after setup: `/login cloudflare-ai-gateway` (or env) ·
`/mcp-auth` per OAuth server · `/trust` per project.

## Drift repair

```sh
scripts/validate.sh   # READ-ONLY audit: ~/.pi is a locked worktree of this repo
                      # on main, status clean, main == origin/main (else DRIFT /
                      # UNPUSHED / BEHIND per line); manifest == tracked agent/;
                      # tools on PATH, env vars set (presence, never values),
                      # git history free of secrets (gitleaks); exit non-zero
                      # on any mismatch
```

Drift is a git diff in `~/.pi`: `git -C ~/.pi diff`, then keep it
(`add -p && commit && push`) or drop it (`checkout -- <file>`).

Cloudflare-routed Anthropic models failing with "credentials … expired" or
"Credentials file not found"? Root cause is a stale Anthropic SDK profile in
`~/.config/anthropic/` (left by `ant auth login`); the SDK auto-loads it because
pi passes `apiKey: null` for header-authenticated gateways. Preferred fix is
`rm -r ~/.config/anthropic` — stock pi then works. Only if that profile must
stay, apply the gateway patch (it does not survive `pi update`):

```sh
scripts/patch-pi-anthropic-gateway              # root from `mise which pi`
scripts/patch-pi-anthropic-gateway --root PATH  # manual override
```

Idempotent (`patched:` / `already patched:` per file); it fails loudly and
touches nothing if a future pi version changes the patched lines.

## Developing

The repo has a dev side that never reaches `~/.pi` (`tests/`, `scripts/` and
the package dirs are outside the sparse cone; root files come along, unused).

```sh
npm test            # extension behavior suites + the encoded imprint matrix
npm run typecheck   # pinned typescript@5.9.3 over tests + extensions
```

Zero dependencies: Node 24 runs the `.ts` natively; an ESM loader hook
(`tests/loader.mjs`) redirects pi's runtime packages to stubs in
`tests/stubs/`, and `tests/harness.mjs` fakes the ExtensionAPI/ctx. The
imprint matrix (`tests/imprint.test.ts`) drives `setup.sh` against throwaway
fixture repos and mktemp targets only — never this checkout's git, never
`~/.pi` — and is the regression net for script changes. The full 210k-file replica imprint stays
a manual pre-ship gate. `npm run typecheck` needs the `.pi-types` symlink
(`ln -s "$(npm root -g)/@earendil-works" .pi-types`; setup.sh's machinery
creates the equivalent in the agent dir).

## Changing config

`~/.pi` is the `main` checkout; never author on it. Branch in a dev worktree,
edit, `npm test`, commit, then deploy by merging:
`git -C ~/.pi merge --ff-only <branch> && git -C ~/.pi push`. That is the whole
deploy for `agent/<path>` (config). For package content (`extensions/`,
`skills/`, `prompts/`, `themes/`) the merge only publishes; the live copy is
pi's clone under `~/.pi/agent/git/github.com/tribble/pawprint`, refreshed by
`pi update --extensions` (bare `pi update` is pi itself only; `/update` or
`auto-update.ts`, ~daily, does both) and picked up on `/reload`. First cutover
only: merge and push *before* the first `pi update --extensions`, or the clone
is of a `main` that has no package yet and loads nothing.
Something pi or an MCP adapter wrote into the live config shows up in
`git -C ~/.pi status`; keep it with
`git -C ~/.pi add -p agent/<file> && commit && push` — `validate.sh` names the
one routine case (pi stamping `lastChangelogVersion` after an upgrade) as
`live:` with that command instead of `DRIFT`. Never in
`~/.pi`: `add -f`, `add -A`, `clean`, `stash -u`, branch switches — the
untracked files there are the credentials and sessions. A branch that starts
tracking a path already present live (an ignored file) overwrites it on merge —
adopt such a file from `~/.pi` (`add` + commit) instead of from a branch.

Two structural layers keep secrets out — the default-deny `.gitignore`
(nothing under `agent/` is tracked unless its directory is allowlisted; never
`agent/**`) and secrets-by-reference in the config itself (`mcp.json` holds
`"!gh auth token"`, a command, never a token) — plus one content scan:
`.githooks/pre-commit` runs `gitleaks` on every staged diff, in `~/.pi` too
(`setup.sh` sets `core.hooksPath`, repo-wide; a missing scanner fails the
commit, since this repo is public) and `scripts/validate.sh` scans the whole
history. Fingerprints for genuine false positives go in `.gitleaksignore`,
each with a comment.
