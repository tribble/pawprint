# pawprint

The curated print of my pi agent config, in two halves. The repo root is a
**pi package** (`package.json` → `pi` manifest): `extensions/`, `skills/`,
`prompts/`, `themes/` — code pi loads from a package, installed with
`pi install git:github.com/tribble/pawprint` (floating `main`;
`pi update --extensions` pulls). Next to it, not pi's: `ghostty/config.ghostty`
(copied out by `setup.sh`) and `mise.toml` (the typecheck toolchain).
`agent/` mirrors `~/.pi/agent`-relative paths and holds exactly the
reviewed-safe *config* files; on my machine `~/.pi` is a **plain
runtime/config directory** that `setup.sh --apply` applies the print onto
(source-only files copy; `settings.json`/`mcp.json` merge field-aware, so pi's
runtime state survives). The default-deny `.gitignore` decides what a checkout
can ever track: nothing under `agent/` is tracked unless its directory is
allowlisted. **`manifest.json` is the adopters'
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

The config half is one person's choices, but pieces of it stand alone. The
catalog is `manifest.json`'s `about` map — one entry per shipped file:

- `does` — what the file does.
- `needs` — what it needs: installed tools (`herdr`, `pr-watch`, `pi-subagents`,
  the Cloudflare gateway) or another catalog path. A file with no `needs`
  stands alone.
- `personal: true` — my own choices (models, gateway, rules, repo paths), not
  something to copy blind. Read the file and adapt it to your setup first;
  `--only` warns on stderr for each such file and copies it anyway.

How a piece works is in the header comment of the file itself
(`agent/<path>`); read that before installing it. `agent/AGENTS.md` is the
owner's own rules, not yours: read it for ideas, but don't edit it.

Cloning this repo does not change your live config in `~/.pi/agent`.
A bare `./setup.sh` (no `--all`, no `--only`) refuses to run and prints these
three commands, so a visitor cannot imprint the whole thing by accident. Plan
with `--dry-run` before copying:

```sh
./setup.sh --list                              # catalog — table on a TTY, JSON [{path, does, needs, personal}] when piped
./setup.sh --dry-run --only cloak.json         # plan only
./setup.sh --only cloak.json                   # copy just that (same backup rules; no machinery)
```

An existing target file that differs is backed up next to itself as
`<path>.bak-pawprint-<timestamp>` before being overwritten (backups only on an
alternate `--target`; the default `~/.pi/agent` is the owner's live dir and is
never copied out of). Nothing is deleted. Exception:
`settings.json` and `mcp.json` are not copied — they are merged field-aware
(`scripts/apply-config.ts`): the catalog's values win per key, your other
settings and servers survive, so no backup is needed. `--target DIR` (or `$PAWPRINT_TARGET`)
copies somewhere other than `~/.pi/agent`.

Prerequisites: every mode needs bash and jq. Source-only copies (`--only`
without `settings.json`/`mcp.json`) need nothing more. Merging
`settings.json` or `mcp.json` also needs node and an installed pi (found via
mise, `npm -g`, or a `pi` on PATH): settings writes go through pi's own
settings storage and the MCP merge is validated against pi's package. A
`--only` naming either JSON file preflights pi's package before its first
selected write and refuses when pi is missing.

`npm test` and `scripts/validate.sh` are my tooling — not needed to adopt
anything. Questions or a broken piece
→ open an issue on the repo.

Working in this repo itself, not adopting? The root `AGENTS.md` is the
contributor side.

## Fresh machine (mine)

This is how *I* set up a new machine; if you are not me, you want "Adopt a
piece" above.

```sh
git clone git@github.com:tribble/pawprint.git ~/work/pawprint
~/work/pawprint/setup.sh --all
```

`setup.sh --all` first establishes the runtime the apply needs (mise toolchain
pin; pi via npm if no `pi` exists yet), then applies the print onto
`~/.pi/agent`, a **plain directory** (never a git worktree), then installs
every package the applied `settings.json` declares (native `pi install
<source> --no-approve` each, in order), then runs the rest of the machine
machinery.
Source-only files copy from the checkout; `settings.json`/`mcp.json` merge
field-aware: source
values win per key, runtime-owned (changelog stamp, device id) and unmanaged
live values survive, unchanged files are not rewritten. Symlinked path
components at or below the config root (`~/.pi`), hardlinked or non-regular
destinations, malformed JSON, and a
git-linked target are refused, never followed or overwritten — and the target
is compared by directory identity (symlink-following), so aliased spellings
(`agent/`, `agent/.`, case variants, a symlinked live dir) cannot sneak past
the backup, symlink, or git-link rules. A `..` component or an empty value in
any target/source path is refused outright — use an absolute path without
`..` — and a newline in a target is refused (it would silently truncate the
path).
Re-runs are idempotent. `setup.sh --apply` is the apply plus the package
installs; it never bootstraps, so it preflights pi's required modules and
exports before any managed write and refuses if they are missing. A failed
install exits nonzero naming the failed source, the config stays applied, and
the printed retry preserves the original mode — `--all` after a failed `--all`
(the remaining machine setup still runs), `--apply` after a failed `--apply`.
`--dry-run`
prints the plan and writes nothing — it needs no pi installation or bootstrap
(bash and jq are still required); `--config-only` or a non-default `--target` skips the package installs and the machine machinery.

The machine machinery after the apply (skipped under `--dry-run` / `--config-only` /
non-default target): agent-browser via npm,
`.pi-types` symlink (repo root, for the
typecheck), ghostty config
copy-out, gh-dash extension. Prereq: `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_GATEWAY_ID` set in
`~/.config/fish/conf.d` (see the dotfiles repo's `pi.fish.template`).

Manual steps after setup: `/login cloudflare-ai-gateway` (or env) ·
`pi mcp login <server>` per OAuth server in `agent/mcp.json` (native MCP;
first run needs fresh browser sign-ins;
tokens land in the ignored `~/.pi/agent/mcp-auth.json`) · `/trust` per project.

## Retiring the worktree

`~/.pi` used to be a locked sparse worktree of this repo. Retiring that is a
metadata-only rename — every file stays in place, and rollback is the same
rename back. The locked worktree's admin entry in the clone survives
`git worktree prune`, so rollback keeps working.

```sh
LIVE=~/.pi; CLONE=~/work/pawprint
```

Migrate — copy the whole block. `set -e` and one check per line: a failed
precondition stops the sequence before the `mv`. (These exact commands are
exercised on synthetic worktrees in `tests/migration.test.ts`.)

```sh
set -e
[ -f "$LIVE/.git" ]                      # .git is a regular gitfile (linked worktree)
[ ! -L "$LIVE/.git" ]                    # …not a symlink
[ "$(git -C "$LIVE" rev-parse --path-format=absolute --git-common-dir)" = "$(git -C "$CLONE" rev-parse --path-format=absolute --git-common-dir)" ]   # a worktree of THIS clone
git -C "$CLONE" worktree list --porcelain | grep -A3 "^worktree $LIVE$" | grep -q '^locked '   # locked admin entry → rollback survives prune
[ ! -e "$LIVE/.git-pawprint-retired" ]   # nothing to clobber…
[ ! -L "$LIVE/.git-pawprint-retired" ]   # …not even a dangling symlink
mv "$LIVE/.git" "$LIVE/.git-pawprint-retired"
if git -C "$LIVE" status >/dev/null 2>&1; then echo "unexpected: still a repo — stop"; exit 1; fi
```

Then refresh the source checkout to the approved revision and apply. The clone
stays **detached**: the retired locked entry keeps `main` reserved, so never
`switch main` — refresh with an explicit fetch + fast-forward:

```sh
git -C "$CLONE" fetch origin main
git -C "$CLONE" merge --ff-only FETCH_HEAD
"$CLONE"/setup.sh --apply
cd "$CLONE" && scripts/validate.sh      # → VALID
```

Rollback — metadata only, any time while the locked admin entry is kept
(re-applying settings is a separate forward step, not part of rollback):

```sh
set -e
[ -f "$LIVE/.git-pawprint-retired" ]     # retired pointer intact, a regular file
[ ! -L "$LIVE/.git-pawprint-retired" ]
[ ! -e "$LIVE/.git" ]                    # no active pointer
[ ! -L "$LIVE/.git" ]
mv "$LIVE/.git-pawprint-retired" "$LIVE/.git"
git -C "$LIVE" status --porcelain        # worktree again, on main
```

Deferred cleanup, only once rollback is no longer wanted: `git -C
~/work/pawprint worktree unlock ~/.pi && git -C ~/work/pawprint worktree
prune`. Afterwards the rename-back does not relink (`git worktree repair`
cannot recreate a pruned entry) — the retired gitfile is then just a file to
delete.
## Drift repair

```sh
scripts/validate.sh   # READ-ONLY audit: ~/.pi is a plain dir whose managed
                      # content matches this checkout (per-file DRIFT/MISSING
                      # lines otherwise); manifest == tracked agent/; tools on
                      # PATH, env vars set (presence, never values), git
                      # history free of secrets (gitleaks); exit non-zero on
                      # any mismatch
```

Drift repair is `setup.sh --apply`. To keep a value pi wrote live (a UI-toggled
preference), copy it into the source repo first — apply leaves unmanaged live
values alone either way.

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

The repo has a dev side that never reaches `~/.pi` (only `agent/` content is
ever applied; `tests/`, `scripts/` and the package dirs stay in the repo).

```sh
npm run types       # create/refresh the local .pi-types symlink to the mise-installed Pi types
npm test            # biome lint (no `any`; per-line opt-outs need a reason), mise-pinned tsc, then the node suites (extension behavior + imprint matrix)
```

Zero dependencies: Node 24 runs the `.ts` natively; an ESM loader hook
(`tests/loader.mjs`) redirects pi's runtime packages to stubs in
`tests/stubs/`, and `tests/harness.mjs` fakes the ExtensionAPI/ctx. The
imprint matrix (`tests/imprint.test.ts`) drives `setup.sh` against throwaway
fixture repos and mktemp targets only — never this checkout's git, never
`~/.pi` — and is the regression net for script changes.

## Changing config

The source of truth is the repo, never the live dir. Start every change in its
own worktree (`git -C ~/work/pawprint worktree add ~/work/pawprint-<branch> -b <branch> origin/main`;
the base checkout is never edited or checked out on a branch; after merge
`git -C ~/work/pawprint worktree remove ~/work/pawprint-<branch> && git branch -d <branch>`),
edit, `npm test`, commit, merge, then deploy (the base checkout stays detached
— the retired worktree metadata keeps `main` reserved — so refresh it with an
explicit fetch + fast-forward, not `pull`):
`git -C ~/work/pawprint fetch origin main && git -C ~/work/pawprint merge --ff-only FETCH_HEAD && ~/work/pawprint/setup.sh --apply`
— the apply's install step also pulls the floating pawprint clone to origin's
latest, so no separate self-update step. For package content (`extensions/`,
`skills/`, `prompts/`, `themes/`) the live copy is pi's clone under
`~/.pi/agent/git/github.com/tribble/pawprint`, refreshed by `pi update
--extensions` (bare `pi update` is pi itself only; `/update` or
`auto-update.ts`, ~daily, does both) and picked up on `/reload`.

Pawprint owns package membership and the exact pins: every third-party package
in `agent/settings.json` is pinned (`@<sha>` / `@<version>`), and the floating
`git:github.com/tribble/pawprint` self entry is the one approved exception —
the daily update moves only pawprint itself. Once a week a session start says
`weekly package review due — /packages`: bare `/packages` lists each pin
against upstream (read-only, the only route that earns review credit).
`/packages bump <name|--all>`, `/packages install <source>` and `/packages
remove <name>` never touch the live config — they queue a source-worktree task
into the active session (queued means requested; nothing changed yet), and
that agent changes `agent/settings.json` through the normal
worktree/review/commit flow, then deploys and independently verifies both the
saved source and the live install state. Apply replaces the live `packages`
array wholesale with the source's, so a live-only `pi install`/`pi remove` is
overwritten by the next apply (old clone files stay on disk) unless authored
in source first. Before bumping `pi-subagents`, see the pin note in
`agent/AGENTS.md`.

Something pi/mcp wrote into the live config just stays there — apply never
touches unmanaged values. Keep one intentionally by copying the value into the
source repo and committing it; `validate.sh` reports managed-value drift.
`~/.pi` is not a git repo: no git mutations there at all.

Two structural layers keep secrets out — the default-deny `.gitignore`
(nothing under `agent/` is trackable unless its directory is allowlisted; never
`agent/**`) and secrets-by-reference in the config itself. In the tracked
`agent/mcp.json`, every secret value is a `${ENV}` reference or a `!command`
(`"!echo Bearer $(gh auth token)"`), never a literal token or client secret;
public values like URLs and client IDs stay literal. `pi mcp add` flags can
write a literal secret into that file — review the config before committing.
Native MCP stores OAuth credentials as plaintext in the ignored
`~/.pi/agent/mcp-auth.json`, mode 0600. If that file is ever exposed, revoke the grants with each
provider; `pi mcp logout <server>` removes the local credentials but is not
revocation. `agent/cloak.json`
masks `mcp-auth.json` token values, but only in `read`-tool output — a `bash` read, including
one called from codemode, is not masked, so the agent/AGENTS.md rule against reading or
copying credential contents through bash/codemode is the control on every other
path — plus one content scan:
`.githooks/pre-commit` runs `gitleaks` on every staged diff
(`setup.sh` sets `core.hooksPath`, repo-wide; a missing scanner fails the
commit, since this repo is public) and `scripts/validate.sh` scans the whole
history. Fingerprints for genuine false positives go in `.gitleaksignore`,
each with a comment.
