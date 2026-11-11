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
- `needs` — what it needs: installed tools (`herdr`, `pr-watch`, `pi-intercom`,
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

## Current-agent progress

The native busy row shows `Model working · 28s` or `Running bash · 12s`
with the configured interrupt key. Parallel tools retain their own elapsed time.
The row clears when the current agent stops. Existing child-agent rows stay
under their package's control. Retry and compaction keep Pi's native displays.

## Session recap

`/recap` summarizes the session with the selected model in a detached request.
The recap stays readable in the transcript after resume without entering the
main model's context. It uses stored context, without request-time extension
annotations. Run it while the agent is idle; `/recap cancel` stops only the recap.

## Cost reports

`/costs [days]` shows per-model medians from **legacy headless-run history**.
Native leaf efforts come from `agent/configs/session-roles.json`, not this table.
`/costs workstream`
shows the calling session's own estimate, grouped root-owned headless work,
and each recorded pane's own and subtree estimates. The total counts native
contributions once across all branches, continuations and folded usage.
Subtree includes own spend. Do not add them together.

Use `/costs workstream full` for the ownership tree, native/legacy IDs, activity and coverage
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

## Native delivery workflow

A responsive project Coordinator launches multiple independent Delivery Leads
concurrently in separate fresh native Herdr task trees. Each Delivery Lead (`delivery-lead`)
is accountable for a high-quality change. It launches sequential native worker and fresh
reviewer leaves, unblocks them, triggers review, mediates and adjudicates findings,
returns valid fixes and reports decisions/results. It escalates stuck work or
unresolved disagreement with a plain-language problem, the decision needed, known
options and a recommendation only when it has one.
Neither main writes code. Herdr owns all processes/panes/lifecycle.
Standalone [pi-intercom](https://github.com/nicobailon/pi-intercom) owns messaging.

Pi >=1.5.0 and the immutable standalone pin in
[`agent/settings.json`](agent/settings.json) are required. Never load both Intercom
extensions. Restart Pi to change SDK versions.
Read the applied `<agent-dir>/configs/managed-code-workflow.md` first.
Pi's `getAgentDir()` resolves nonempty `PI_CODING_AGENT_DIR` with Pi's path expansion,
otherwise `~/.pi/agent`. The [repository recipe](agent/configs/managed-code-workflow.md)
does not replace a missing applied recipe. Pawprint uses `origin/main` and
`/Users/pantera/work/pawprint-worktrees/<branch>`. Herdr does not fetch.

The parent creates and verifies a fresh native task tree, then launches its owner:

```js
launch_agent({
  name: "delivery-lead",
  role: "delivery-lead",
  cwd: "/verified/native/task/tree",
  task: "Owner outcome:\n<verbatim ask>\n\n<bounded delivery and acceptance>"
});
```

The Delivery Lead uses `launch_agent({name,role:"worker",cwd,task})`, then fresh
`reviewer` and, only for a concrete change to permissions, trust, credential handling,
command execution or ownership/deletion safeguards, a separate `reviewer-security`.
[Profiles](agent/configs/session-roles.json) supply qualified model, native effort,
instruction file and the complete selected contract in the actual prompt.
Opus workers use high, trivial-configuration fixers low, default Sol reviewers xhigh.
When review is needed, use `reviewFamily:"openai"` for Anthropic-authored output
or `reviewFamily:"anthropic"` for OpenAI-authored output, including Astra.
Both review roles select qualified models from their `reviewModels` config and keep xhigh.
Omission keeps the configured default. The launcher does not infer authorship.
Writer/scout/context-builder use medium and oracle/debugger high.
No fallback model, parent-effort change or reviewer tool mask is used.
Read-only roles are prompt contracts, not a sandbox.

Code leaves require the owner's current native UUID/file/pane and same linked task tree.
A replacement owner the human asked to take over may continue there. Predecessor and
background-command settlement is a manual check: the launcher detects only live agents
in the tree and the caller's own live or uncertain launches there, whatever their role.
The original full main of an isolated successful fixer/writer
delivery may also launch reviewer/security leaves there after verified actor/command closure;
workers still require the tree's delivery owner. They create no second worktree or persistent writer claim.
The launcher reuses the admission lock and refuses legacy claims, unknown occupants
and uncertain replay. Only the owner starts the next leaf after prior actor/command closure.
Leaves cannot launch actors or trigger review.

Non-code writer/scout/context-builder/oracle/debugger roles use the native launcher
with explicit assigned cwd. Writer and trivial-configuration fixer need an unclaimed
linked task tree. Fixer can bypass a Delivery Lead through the same admission gate.
Read-only roles can use their assigned directory without a managed wrapper.
See [delegation](agent/configs/delegation.md) for contracts and continuation commands.

Standalone Intercom routes by native session UUID through its supported identity hook.
Renames keep it. Replacement changes it. Resume restores the saved UUID.
Use `intercom status` and `list`, never a hash or workspace label.
Supported actions are list, list-cwd, send, ask, reply, pending, status, cancel and handover.
There is no bundled last/scope/per-message delivery/queueMode API.
Busy delivery is global steer or human-first.
Model `openProjectPaneIfMissing: true` calls are blocked, including nested codemode
send/ask/handover. Explicit human slash commands are separate entrypoints.

End turns after launch and receive reports through Intercom.
Inspect with `herdr agent get <recorded-pane>` and
`herdr agent read <recorded-pane> --source recent-unwrapped --lines 120`.
Immediately before any native prompt or close, run `herdr agent get <recorded-pane>`
and require its session UUID to match the original recorded UUID. Missing or mismatched
identity stops the action. Continue a settled verified owned session with `herdr agent prompt` carrying
the verbatim Owner outcome. No answer blocks dependent work.
An uncertain start or task submission may already have taken effect. Inspect before recovery.

The parent owns integrated acceptance, authorized publication and cleanup.
After verified settlement and command/descendant exits, close the recorded owned pane
with `herdr pane close <recorded-pane>` and inspect native state afterward.
After review, close the reviewer and launch a fresh worker for fixes; the previous worker
is already closed. Busy-stop safety is unproven.
A completed report, idle label or pane-close receipt does not prove detached descendants exited.
Preserve original native receipts and process/command exits.
Preserve ignored evidence before authorized non-force native removal.

### Main roles and legacy claims

Default sessions and Coordinators use Astra/medium.
Full-workstream Coder and Delivery Lead retain Astra/high.
Legacy `role:"coder"` and `role:"coordinator"` APIs remain available.
Legacy Coder creates a linked tree from committed HEAD or base, or admits explicit cwd.
Coordinator keeps directory behavior and rejects base.
Delivery Lead requires an existing native linked cwd and the unique matching workspace.
`managed-coder` remains a legacy alias of `delivery-lead`.
It creates neither worktree nor persistent writer claim.
A live or uncertain earlier launch of any role blocks same-parent replay into that tree.
After the predecessor closes, the same parent may launch a replacement there.
First settle the predecessor and its background commands manually.
The receipt names the previous Delivery Lead but does not check its command exits.

After an Opus worker, both reviews use OpenAI/Sol.
For OpenAI-authored output, including Astra, use `--review-family anthropic` for both instead.

```text
/delegate --role delivery-lead --cwd "/native/task/tree" <name> <task>
/delegate --role worker --cwd "/same/admitted/tree" <name> <task>
/delegate --role reviewer --review-family openai --cwd "/same/admitted/tree" <name> <task>
/delegate --role reviewer-security --review-family openai --cwd "/same/admitted/tree" <name> <task>
/delegate --role scout --cwd "/assigned/directory" <name> <task>
/release-worktree "/path/to/legacy/pre-pane-failure"
/ws [--no-approve] [repo|dir] <purpose>
```

Human /ws starts a focused interactive Coordinator.
Delegated mains and leaves use no-focus tabs and inherit the agent directory.
The native leaf marker and legacy child lineage block actor launches,
including cached tools and command paths. No lineage is cleared.

Native unresolved trust requires human action or explicit noProjectResources/--no-approve.
Never answer trust/auth prompts automatically.
Legacy claims bind native UUID and canonical parent file. Only that owner may release
a recorded pre-pane failure. Any pane/start attempt or uncertain identity keeps the claim.
Release removes only the claim, never Git state. No stale reclaim or launcher cleanup.

Before live cutover, migrate PR companions to the standalone client and re-register
tracked PRs against their standalone IDs. Old broker targets cannot reach standalone peers.
Preserve saved child histories and verify the live transition before removing any old clone.

## PR helper CLIs

Normal `setup.sh --apply` and `--all` copy `scripts/pr-note` and `scripts/pr-steer`
to `~/.local/bin` with executable permissions, after package installation. Add that
directory to PATH. Symlinked and hardlinked destinations are refused. `--only`,
`--config-only`, `--dry-run` and alternate targets do not install helpers.

The helpers use the installed pinned standalone client's own `tsx` loader.
Its default location is `<agent-dir>/git/github.com/nicobailon/pi-intercom`;
`PI_CODING_AGENT_DIR` selects the agent directory and `PI_INTERCOM_HOME` can select
a custom standalone installation. No bundled client is loaded.

`pr-note --list` lists live recipients. `pr-note --resolve <exact-name>` returns
an ID and refuses ambiguous names. `pr-steer --to <ID> --body <text>` sends watcher
updates; `pr-note --help` documents editor notes, JSON input and recipient precedence.
Both helpers preflight the exact ID against connected sessions before sending.
Broker delivery is not proof that the recipient acted on the message.
An owner and its native leaf can share cwd. Directory inference then refuses ambiguity;
use `--to <UUID>` or existing recorded PR ownership. Recipient precedence is unchanged.

### Coordinated migration

Keep pawprint before standalone Intercom in the package list so the native UUID
identity claim wins over stable-ID environment/config sentinels. Never load both
Intercom extensions. A floating pawprint update can update the launcher before
settings and helpers: coordinate publication and apply as one parent-owned rollout.

Before rollout, verify an isolated source-loaded native hierarchy with authenticated
models, UUID identity, sequential worker/fresh-review closure and real helper delivery.
Also verify the model auto-project-pane guard is active in the loaded candidate.
Compare configured broker socket/PID namespaces first. Bundled defaults use the OS temp
namespace (`/tmp/pi-intercom-<uid>` on this Mac); standalone defaults use
`<agent-dir>/intercom`. These are disjoint here. Do not kill or clean up a broker on an
assumed collision. Disjoint sessions and helpers cannot message each other.
Retain old clones and saved histories until loaded sessions and continuations are
accounted for. `/reload` neither upgrades the SDK nor migrates saved child bindings.
After apply, start fresh sessions and re-register every watched PR with its verified
new standalone UUID using `pr-watch track owner/repo#N --agent <UUID>`.
Verify delivery to that recorded recipient. Watcher polling is unchanged.

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
<source> --no-approve` each, in order), installs the PR helper CLIs, then runs
the rest of the machine machinery.
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
and PR helper installs; it never bootstraps, so it preflights pi's required modules and
exports before any managed write and refuses if they are missing. A failed
install exits nonzero naming the failed source, the config stays applied, and
the printed retry preserves the original mode — `--all` after a failed `--all`
(the remaining machine setup still runs), `--apply` after a failed `--apply`.
`--dry-run`
prints the plan and writes nothing — it needs no pi installation or bootstrap
(bash and jq are still required); `--config-only` or a non-default `--target` skips
package/helper installs and the machine machinery.

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
metadata-only rename — every file stays in place. Keep the locked admin entry
only for a temporary rollback window. During that window it reserves `main`,
so the source clone remains detached. Complete the cleanup below before
routine deployment: the steady state is `~/work/pawprint` on `main` and
`~/.pi` a plain directory.

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

Rollback during the temporary window — metadata only, while the locked admin entry is kept
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

Complete the migration only once rollback is no longer wanted and the
retired worktree has no running actors, unresolved decisions or writer claims.
Pruning ends metadata-only rollback: renaming the retired gitfile back no
longer relinks, and `git worktree repair` cannot recreate the pruned entry.
Verify that `.git-pawprint-retired` still names this clone's exact retired
admin entry, that its `gitdir` points to `$LIVE/.git`, and that its `HEAD`
names `refs/heads/main`. Check that the source checkout is clean.
Do not remove live files or use `git worktree remove` on `$LIVE`.
If cleanup stops for any reason after unlocking but before pruning, relock
the retired entry before leaving it:
`git -C "$CLONE" worktree lock --reason "live pi config" "$LIVE"`.

```sh
set -e
git -C "$CLONE" worktree unlock "$LIVE"
git -C "$CLONE" worktree prune --dry-run --verbose --expire now
```

Inspect the dry-run output. Continue only if it lists exactly the retired
admin entry and no other worktree. If it lists another entry, stop without
pruning. Recheck the dry-run immediately before the next block.

```sh
set -e
git -C "$CLONE" worktree prune --verbose --expire now
git -C "$CLONE" switch main
test "$(git -C "$CLONE" symbolic-ref --quiet HEAD)" = refs/heads/main
```

The retired gitfile can then be deleted. Leave every live config file in place.

Refresh and apply only from `main`. This guard refuses a detached HEAD or
another branch before fetch, merge or apply:

```sh
set -e
test "$(git -C "$CLONE" symbolic-ref --quiet HEAD)" = refs/heads/main
git -C "$CLONE" fetch origin main
git -C "$CLONE" merge --ff-only FETCH_HEAD
"$CLONE"/setup.sh --apply
cd "$CLONE" && scripts/validate.sh      # → VALID
```

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

## Developing

The repo has a dev side that never reaches `~/.pi` (only `agent/` content is
ever applied; `tests/`, `scripts/` and the package dirs stay in the repo).

```sh
npm ci              # in a task worktree: install the locked development dependencies
npm test            # local oxlint --type-aware, tsc, then the node suites
npm run typecheck   # local tsc only
```

Mise supplies Node 26. The SDK/types, lint and typecheck tools are pinned in
`package.json` and `package-lock.json` and resolve from the worktree's
`node_modules`. Development installs leave the shared Pi runtime and live
config alone. Pi's package install omits development dependencies and uses
the optional runtime peers.

Node 26 runs the `.ts` natively; an ESM loader hook
(`tests/loader.mjs`) redirects pi's runtime packages to stubs in
`tests/stubs/`, and `tests/harness.mjs` fakes the ExtensionAPI/ctx. The
imprint matrix (`tests/imprint.test.ts`) drives `setup.sh` against throwaway
fixture repos and mktemp targets only — never this checkout's git, never
`~/.pi` — and is the regression net for script changes.

## Changing config

The source of truth is the repo, never the live dir. Start every change in its
fresh task worktree. Code changes of any size follow the
[managed code workflow](#managed-code-workflow) with the explicit grouped path
`~/work/pawprint-worktrees/<branch>` and `origin/main` base. New task worktrees
group there; the main checkout stays `~/work/pawprint`, and existing worktrees stay
where they are. Only trivial configuration or non-code work outside the
code flow can use the direct
`git -C ~/work/pawprint worktree add ~/work/pawprint-worktrees/<branch> -b <branch> origin/main` path.
Keep the base checkout on `main`; never detach it or author changes there.
Authorized direct-tree cleanup uses
`git -C ~/work/pawprint worktree remove <recorded tree path>` after the same
actor/decision/claim/occupant/artifact checks described above. Native trees also
require the exact workspace identity check. After verified merge and successful
verified tree removal, delete the delivery's merged task branch locally and remotely
as part of the authorized delivery; no separate approval is needed. Follow the
[recipe's merged-branch deletion steps](agent/configs/managed-code-workflow.md#merged-branch-deletion):
exact recorded merged head, `git -C ~/work/pawprint branch -d <branch>` first, `-D`
only for missing squash/rebase ancestry, fresh `ls-remote` equality before
`git -C ~/work/pawprint push origin --delete <branch>`. Keep abandoned/unmerged
branches unless separately authorized. In the task worktree,
edit, `npm test`, commit, merge, then deploy. Refuse a non-`main` base before
fetching, fast-forwarding or applying:
`test "$(git -C ~/work/pawprint symbolic-ref --quiet HEAD)" = refs/heads/main && git -C ~/work/pawprint fetch origin main && git -C ~/work/pawprint merge --ff-only FETCH_HEAD && ~/work/pawprint/setup.sh --apply`
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
in source first. Before bumping `pi-intercom`, see the pin note in
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
revocation. `agent/cloak.json` masks configured matches in `read`, `bash` and `grep`
output, including inner tool calls from codemode. Path-based masking requires a
matching file path in the call. Never read or copy credential contents through
bash/codemode.
`.githooks/pre-commit` runs `gitleaks` on every staged diff
(`setup.sh` sets `core.hooksPath`, repo-wide; a missing scanner fails the
commit, since this repo is public) and `scripts/validate.sh` scans the whole
history. Fingerprints for genuine false positives go in `.gitleaksignore`,
each with a comment.
