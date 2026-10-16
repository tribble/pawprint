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

My default Pi theme is `gruvbox-tribble`, matched to herdr's dark Gruvbox
palette and Ghostty's built-in `Gruvbox Dark Hard`. Both `gruvbox-tribble` and
`calm-tribble` ship in the package; switch back through `/settings` → Theme.

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

## Managed PR workstreams

Coordinator-led PR work uses a fresh native herdr worktree/workspace, then
`managed-coder-trial` through the public `delegate` tool. The managed Coder
supervises sequential Sol implementation and fresh independent Opus review.
It uses Astra/high with a depth ceiling of two. Ordinary workers and reviewers
remain leaves. Keep a persistent saved Coordinator session for run/question recovery.
After apply, refresh the launching parent and verify its effective depth limit
before launching managed work.

For pawprint, preflight an unused branch and absent sibling path, including
dangling symlinks and registered worktrees. Resolve and record `origin/main`
immediately before creation; herdr does not fetch.

```sh
herdr worktree create --cwd /Users/pantera/work/pawprint --branch <branch> \
  --base origin/main --path /Users/pantera/work/pawprint-<branch> \
  --label <branch> --no-focus
```

Read `.result.worktree.path` and `.result.workspace.workspace_id`. Independently
verify the returned path, branch, HEAD/base and Git common directory against
the requested path/branch/base and source repository. Keep the canonical path,
`repo_key`, base commit, exact `workspace_id` and every run/continuation ID in the plan.

```text
delegate({agent:"managed-coder-trial",cwd:<returned path>,async:true,
  task:<verbatim Owner outcome + scoped brief with assigned absolute path>})
```

Do not set `worktree:true` or attach another workstream or pane Coder to this tree.
Preserve legacy/uncertain pawprint claims. Reconcile uncertain creation/launch
receipts against native/Git readback and saved runs before recovery; never retry blindly.
The shell and installed diff-review plugin provide workspace access without a Coder pane.

Child owner decisions travel through a separately saved managed-Coder supervisor
question to the same human-facing Coordinator. Recover `agent_runs` questions
in that same saved session. Return the authoritative saved answer to the exact
Coder question; the Coder answers the original child run/question.
PR context grants children no publication authority.

Only an authorized Coordinator removes the workspace after merge or authorized
abandonment, every recorded task agent/command has finished and no decision or
answer delivery remains pending. Include nested runs, continuations and command
descendants in that check. Herdr does not account for detached headless writers.
A terminal run, Stop receipt or idle/absent pane is insufficient.
Just before removal, freshly match the exact recorded `workspace_id` row in
`herdr workspace list` to the recorded canonical `checkout_path`, `repo_key` and
`is_linked_worktree: true`. Never use list positions or workspace numbers.
Inspect the Git admin directory for `pawprint-writer.json` or `pawprint-writer.lock`,
including symlinks. Freshly check `herdr agent list` entries' canonical `cwd` and
`foreground_cwd` for occupants at or below the task path. Any claim, lock, occupant,
identity mismatch or unknown/unreadable inspection means keep the tree. Never
remove, release or bypass claims. Visible agents do not prove detached writers finished.

Non-force removal deletes ignored files too. Preserve needed artifacts and delivery
evidence first. Use `herdr worktree remove --workspace <recorded workspace_id>`
without force, then verify native/Git readback. Dirty refusal means keep and inspect
the tree. Removal leaves the branch. Only after verified merge and successful
verified tree removal, explicit branch deletion authority permits
`git -C ~/work/pawprint branch -d <branch>`. Keep abandoned/unmerged branches unless
separately authorized. Never force or auto-remove.

The full Coordinator recipe is in
[`agent/configs/session-role-coordinator.md`](agent/configs/session-role-coordinator.md).
`launch_agent`, human `/delegate`, `/ws` and `release_worktree` remain explicit
pane workflows. Human `/delegate` is not managed `delegate`.

## Pane role profiles

`herdr-fleet` reads `<agent-dir>/configs/session-roles.json` at launch time.
Each Coordinator/Coder profile selects `model` (qualified `provider/id`, including
multi-segment IDs), `thinking`, and `instructionsFile` (relative to the config
directory). Both ship with Astra/high. The source-managed Markdown instruction
files preserve their full contents through native `--append-system-prompt` file
input. A second append argument supplies the one-line interaction contract.
Apply the config and both instruction files with the extension. Profile selection
never changes `defaultModel`. Explicit append flags replace native
`APPEND_SYSTEM.md` discovery; include any instructions you need from that file
in your role instruction files.

Agents invoke the native `launch_agent` tool with `name` and `task` (including
the owner's verbatim `Owner outcome:` block). Optional fields are `role`, `cwd`,
`base` and `noProjectResources` (explicit native trust opt-out). It defaults to Coder;
use `role: "coordinator"` for a nested Coordinator. This is the explicit pane
workflow. The separate `delegate` tool runs managed headless subagents.

`extensions/subagent/config.json` is source-owned and copied wholesale on apply.
Before deploying, check for unrelated live keys and preserve them in source.
With no explicit parent trust flag, child runs inherit native hook/store/default
trust policy. Unknown headless projects can start with protected project resources
skipped; AGENTS.md and CLAUDE.md still load. Explicit parent trust flags propagate.
Existing argv and saved continuation policies remain in effect; use fresh runs
after refreshing the launching parent.

Human shortcuts:

```text
/delegate <name> <task>
/delegate --base origin/main <name> <task>
/delegate --role coordinator <name> <task>
/delegate --cwd "/path/to/worktree" --no-approve <name> <task>
/release-worktree "/path/to/worktree"
/ws [--no-approve] [repo|dir] <purpose>
```

`launch_agent` and human `/delegate` are delegated-only and retain parent
Intercom provenance. Human `/ws` starts an interactive Coordinator in a focused
workspace. Coordinator names reserve the role marker and collision suffix
before purpose truncation. A name such as `coordinator-3d-print` keeps its
leading role marker so its numeric purpose remains legal.

Pane delegation opens a no-focus tab in the current workspace and delivers the task
to the returned pane ID. A Coder without `cwd` gets a fresh sibling linked
worktree from the effective repository, including `change_dir`. It starts from
committed `HEAD`, or the immutable commit resolved from `base`. Pawprint callers
supply `base: "origin/main"`. The launcher does not fetch or transfer dirty edits.

Explicit Coder `cwd` reuses exactly that existing linked checkout/subdirectory;
primary checkouts, non-Git paths, existing claims and observed same-tree unowned
sessions are refused. The unclaimed launching parent may plan alongside its
single Coder. Claims use canonical Git administrative directories, so symlink
and subdirectory aliases cannot admit a second writer. Never combine `cwd` and
`base`. Coordinators keep directory behavior and reject `base`.

Relative cwd uses the effective directory; explicit absolute directories and
known repo-map paths can recover after the old directory disappears. Children
receive the caller's `PI_CODING_AGENT_DIR` so profile and trust sources match.
Launch receipts include the source/final directories, branch, base commit,
launch/child IDs, claim path and native pane. Parent-side native session entries
record ownership by UUID and canonical native parent session-file path. Coder
parents need persistent sessions; in-memory parents are refused before mutation.
Copied or moved session files do not adopt claims; symlink aliases normalize.
`/fleet` does not infer ownership from workspace grouping.

Native trust is checked at the resulting cwd. An unresolved decision prevents
pane creation and task Enter; an already-created Git worktree and claim remain. Human `/ws` sends no input and lets native Pi show its focused trust
dialog; only explicit `--no-approve` opts out on that path.
For a recorded claimed pre-pane failure, first release its claim from the
UUID/file-bound parent with `release_worktree({cwd})` or `/release-worktree <cwd>`.
Then start Pi interactively in that exact worktree and choose trust yourself;
exit that Pi before relaunching with exact `cwd`. Alternatively, after release,
relaunch with exact `cwd` and `--no-approve` / `noProjectResources` to decline
protected resources. Saved decisions and native global policy are respected.
If trust becomes unresolved after startup, keep and inspect the returned pane.
Confirm Pi is running, resolve its native trust prompt yourself, and paste the
original task only when the Pi editor is ready — never into a shell. Do not
retry the launcher. Never retry an uncertain start or delivery blindly.

The launch tool is omitted for headless leaf subagents; the shared boundary also
rejects their calls. These guards are workflow boundaries, not an OS sandbox.
Interaction mode grants no additional ship authority. Authority comes from the
actual owner request, scoped handoff and applicable standing policy.
Isolate independent workstreams. Sequence changes that depend on an unsettled
API or migration.

Claims survive child exit, cancellation and uncertain delivery. Only the
UUID/file-bound owner can call `release_worktree({cwd})` or `/release-worktree
<cwd>` for a recorded pre-pane failure, when no child was started. Any pane/start
attempt or uncertainty keeps the claim: pane absence cannot prove detached
workers stopped. Completed Coder worktrees cannot be reassigned through the
launcher yet. Post-start reconciliation/release is deferred.

Release is serialized with admission and removes only the claim, never a branch
or checkout. It does not reclaim by age, idle status or manual attestation.
Inspect the receipt's Git state and native pane after a failure; keep partial
state and never retry blindly. A successful Git add can leave a branch even
when a later response fails.

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
fresh task worktree. Direct worker/fixer/manual paths use
`git -C ~/work/pawprint worktree add ~/work/pawprint-<branch> -b <branch> origin/main`.
Coordinator-led PR work follows [Managed PR workstreams](#managed-pr-workstreams)
with the explicit sibling path and `origin/main` base. The base checkout is
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
