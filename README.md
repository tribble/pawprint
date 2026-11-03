# pawprint

The curated print of my pi agent config, in two halves. The repo root is a
**pi package** (`package.json` → `pi` manifest): `extensions/`, `skills/`,
`prompts/`, `themes/` — code pi loads from a package, installed with
`pi install git:github.com/tribble/pawprint` (floating `main`;
`pi update --extensions` pulls). Next to it, not pi's: `ghostty/config.ghostty`
(copied out by `setup.sh`) and `mise.toml` (the Node runtime).
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

My default Pi theme is `system`, generated from Ghostty's built-in
`Modus Vivendi Tinted` palette. Herdr's custom chrome uses Pi's generated
semantic colors.
`gruvbox-tribble` and `calm-tribble` remain available in the package through
`/settings` → Theme.

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

## Session recap

`/recap` summarizes the session with the selected model in a detached request.
The recap stays readable in the transcript after resume without entering the
main model's context. It uses stored context, without request-time extension
annotations. Run it while the agent is idle; `/recap cancel` stops only the recap.

## Cost reports

`/costs [days]` keeps the per-model subagent medians. `/costs workstream`
shows the calling session's own estimate, grouped root-owned headless work,
and each recorded pane's own and subtree estimates. The total counts native
contributions once across all branches, continuations and folded usage.
Subtree includes own spend. Do not add them together.

Use `/costs workstream full` for the run tree, run IDs, activity and coverage
diagnostics. The model-facing counterpart is
`agent_costs({mode: "workstream", full: true})`; omit `full` for the compact view.
`agent_costs({days: 7})` retains the per-model table.

Workstream ownership comes from recorded native owner edges, not workspace
membership. Native sources must stay under the agent's sessions directory.
Headless sources use the immediate owner's session-file stem directory or
the standard fork-context layout in that owner's native session directory.
Forks require a matching filename/native identity and `parentSession` bound
to the canonical owner file, alongside recorded run and launch ownership.
Missing launch metadata, copied/moved histories and custom headless directories
without file-bound ownership appear as unknown coverage.
Unrecorded legacy launches are not discovered. Unsupported source versions,
missing usage, unpriced history and running work stay visible. Historical
prices are never replaced with current model rates.

Herdr activity uses an asynchronous read-only agent list matched to native
identity and recorded pane. Ready means ready for input, not completed work.
These are recorded cost estimates. Spending remains uncapped.

## Managed code workflow

Pi >=1.5.0 and pi-subagents 0.52.14 are required. Restart Pi to change SDK versions;
`/reload` does not upgrade the host. A CLI version alone does not prove child SDK identity.

Any full session can own a delivery. The parent creates a fresh native herdr worktree,
verifies the returned repository/path/base, then launches a bounded **main** Coder:

```js
launch_agent({
  name: "delivery-coder",
  role: "managed-coder",
  cwd: "/verified/path/from/native/herdr/receipt",
  task: "Owner outcome:\n<verbatim ask>\n\n<bounded delivery and assigned cwd>"
});
```

Read the applied `<agent-dir>/configs/managed-code-workflow.md` first. Pi's
`getAgentDir()` uses nonempty `PI_CODING_AGENT_DIR` with Pi's path expansion,
otherwise `~/.pi/agent`. The [repository recipe](agent/configs/managed-code-workflow.md)
is the source, not a substitute for a missing applied recipe. Pawprint uses
`origin/main` and `/Users/pantera/work/pawprint-<branch>`; Herdr does not fetch.

The bounded Coder delegates sequential implementation to
`cloudflare-ai-gateway/gpt-6.1-sol`, then independent fresh review to
`cloudflare-ai-gateway/claude-opus-5-5`. Risky changes also get fresh security review.
Adjudication stays in that Coder, outside the human-facing parent's context.
It allows at most three implementation/review rounds. Existing participants do not
recursively wrap. Only trivial configuration bypasses the code flow; read-only and
non-code work use the role contracts in [delegation.md](agent/configs/delegation.md).

Headless calls use `delegate({prompt,name,cwd,model,context:"fresh"})`. Put the
complete role and every verbatim Owner outcome in the prompt, with a qualified model
in the actual model argument. Names do not load profiles. Thinking is inherited.
There are no per-child effort controls, fallback catalogs or reviewer tool masks.
Read-only review is a prompt contract, not a sandbox.

Delegation is async. End the turn after launch and resume on completion.
`agent_runs` supports list, inspect, continue and stop in the owning native main.
Ordinary Intercom send/ask/reply handles decisions. No answer means blocked work.
The parent handles continuation manually; there is no durable question ledger or
automatic restart. Keep returned run/successor IDs and command exit evidence.

The launching parent owns scope, decisions, integrated acceptance, authorized
publication and native cleanup. The bounded Coder reports owned actor/command
closure and remains idle for parent shutdown. Review completion, an idle pane,
a terminal result or a Stop receipt does not prove detached descendants closed.
Unknown actors or identities mean keep the tree. Preserve ignored evidence before
authorized non-force native removal. Native receipt and process/run records are
authoritative; a child-editable plan only indexes them.

## Native pane roles and legacy claims

`herdr-fleet` reads `configs/session-roles.json` at launch time. Coordinator,
full-workstream Coder and bounded managed Coder select a qualified model, native
thinking and prompt instruction file. All currently use Astra/high. Role contents
are passed through native `--append-system-prompt`; this does not change defaultModel.
Explicit append flags replace native APPEND_SYSTEM.md discovery.

`managed-coder` requires an existing native linked cwd and rejects base. It creates
no worktree or persistent writer claim. The existing admission gate prevents
concurrent admission and rejects legacy claims and observed same-tree occupants.
A prior recorded same-parent managed launch prevents replay into that tree.
Herdr owns creation/removal. Never repurpose a claimed or narrowly assigned pane tree.

Existing `role:"coder"` and `role:"coordinator"` pane APIs remain available for
substantial independent workstream ownership. Legacy Coder defaults to a fresh linked
checkout from committed HEAD, or base; explicit cwd admits exactly a linked tree.
Never combine cwd/base. Coordinator keeps directory behavior and rejects base.
The direct unclaimed parent may plan beside its single Coder. Claims bind canonical
Git admin directory, native UUID and canonical parent session-file path. Copied or
moved sessions do not adopt ownership. Workspace grouping does not imply ownership.

Human shortcuts:

```text
/delegate --role managed-coder --cwd "/native/task/tree" <name> <task>
/delegate [--base origin/main | --cwd "/linked/tree"] <name> <task>
/delegate --role coordinator <name> <task>
/release-worktree "/path/to/legacy/pre-pane-failure"
/ws [--no-approve] [repo|dir] <purpose>
```

Pane delegation is delegated-only and opens a no-focus tab in the current workspace.
It retains parent provenance and delivers to the returned native pane. Human /ws
starts a focused interactive Coordinator. Children inherit the configured agent
directory. Both new Intercom lineage variables and the old child marker block pane
launches, including cached tools and command paths; no lineage is cleared.

Native unresolved project trust stops delivery. A human must choose trust, or the
caller explicitly opts out with noProjectResources/--no-approve. Never answer trust
or auth prompts automatically. An uncertain start or task submission may already
have taken effect: inspect the returned pane and saved identity, never retry blindly.

Legacy claims survive child exit, cancellation and uncertain delivery. Only the
UUID/file-bound owner may release a recorded pre-pane failure through release_worktree.
Any pane/start attempt or uncertain identity keeps the claim. Post-start reconciliation
is not added here. Release is serialized with admission and removes only the claim,
never a checkout or branch. No age-based reclaim, manual attestation or automatic cleanup.

## Fresh machine (mine)

This is how *I* set up a new machine; if you are not me, you want "Adopt a
piece" above.

```sh
git clone git@github.com:tribble/pawprint.git ~/work/pawprint
~/work/pawprint/setup.sh --all
```

`setup.sh --all` first establishes the runtime the apply needs (mise Node
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
non-default target): agent-browser via npm, ghostty config
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
npm ci              # in a task worktree: install the locked development dependencies
npm test            # local oxlint --type-aware, tsc, then the node suites
npm run typecheck   # local tsc only
```

Mise supplies Node 24. The SDK/types, lint and typecheck tools are pinned in
`package.json` and `package-lock.json` and resolve from the worktree's
`node_modules`. Development installs leave the shared Pi runtime and live
config alone. Pi's package install omits development dependencies and uses
the optional runtime peers.

Node 24 runs the `.ts` natively; an ESM loader hook
(`tests/loader.mjs`) redirects pi's runtime packages to stubs in
`tests/stubs/`, and `tests/harness.mjs` fakes the ExtensionAPI/ctx. The
imprint matrix (`tests/imprint.test.ts`) drives `setup.sh` against throwaway
fixture repos and mktemp targets only — never this checkout's git, never
`~/.pi` — and is the regression net for script changes.

## Changing config

The source of truth is the repo, never the live dir. Start every change in its
fresh task worktree. Code changes of any size follow the
[managed code workflow](#managed-code-workflow) with the explicit sibling path
and `origin/main` base. Only trivial configuration or non-code work outside the
code flow can use the direct
`git -C ~/work/pawprint worktree add ~/work/pawprint-<branch> -b <branch> origin/main` path. The base checkout is
never edited or checked out on a branch. Authorized direct-tree cleanup uses
`git -C ~/work/pawprint worktree remove ~/work/pawprint-<branch>` after the same
actor/decision/claim/occupant/artifact checks described above. Native trees also
require the exact workspace identity check. Only after verified merge and successful
verified tree removal, explicit branch deletion authority permits
`git -C ~/work/pawprint branch -d <branch>`. Keep abandoned/unmerged branches unless
separately authorized. In the task worktree,
edit, `npm test`, commit, merge, then deploy (the base checkout stays detached
— the retired worktree metadata keeps `main` reserved — so refresh it with an
explicit fetch + fast-forward, not `pull`):
`git -C ~/work/pawprint fetch origin main && git -C ~/work/pawprint merge --ff-only FETCH_HEAD && ~/work/pawprint/setup.sh --apply`
— the apply's install step also pulls the floating pawprint clone to origin's
latest, so no separate self-update step. For package content (`extensions/`,
`skills/`, `prompts/`, `themes/`) the live copy is pi's clone under
`~/.pi/agent/git/github.com/tribble/pawprint`, refreshed by `pi update
--extensions` (bare `pi update` is pi itself only; `/update` does both) and
picked up on `/reload`.

Pawprint owns package membership and the exact pins: every third-party package
in `agent/settings.json` is pinned (`@<sha>` / `@<version>`), and the floating
`git:github.com/tribble/pawprint` self entry is the one approved exception, so
`pi update --extensions` moves only pawprint itself. Once a week a session start says
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
