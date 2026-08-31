# pawprint

The curated print of my pi agent config. This repo is a **source of safe
config, never a mirror of a sensitive directory**: `~/.pi/agent` contains
`auth.json`, OAuth state, sessions, and tool-rewritable files, so it must
never be a git root again. **Never `git init ~/.pi/agent` again.**

`pi-agent/` mirrors `~/.pi/agent`-relative paths and holds exactly the
reviewed-safe files. The repo imprints itself onto a machine by **copying** —
never symlinks: a tool writing its config through a symlink would write into
this repo, and the leak vector returns.

## Fresh machine

```sh
git clone git@github.com:tribble/pawprint.git ~/work/pawprint
~/work/pawprint/setup.sh
```

`setup.sh` imprints `pi-agent/*` into `~/.pi/agent` (override:
`--target DIR` or `PAWPRINT_TARGET`), backing up differing files to
`<path>.bak-pawprint-<ts>` and skipping identical ones. `--dry-run` prints
the plan and writes nothing. `--imprint-only` skips the machine machinery.

The machine machinery (skipped under `--dry-run` / `--imprint-only` /
non-default target) then bootstraps the rest: pi + agent-browser via npm,
mise toolchain pin, `.pi-types` symlink, packages from the
`pi-agent/settings.json` manifest, ghostty config copy-out, gh-dash
extension. Prereq: `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_GATEWAY_ID` set in
`~/.config/fish/conf.d` (see the dotfiles repo's `pi.fish.template`).

Manual steps after setup: `/login cloudflare-ai-gateway` (or env) ·
`/mcp-auth` per OAuth server · `/trust` per project.

## Drift repair

Re-run `setup.sh`. Files you changed locally are backed up, then restored to
the print.

## Keeping a change (live → repo)

```sh
scripts/sync-back.sh   # copies live → pi-agent/ for a hardcoded known-safe list
```

That copy is the review moment: the script touches only the paths in its
`paths=(...)` list (never a wildcard; never `auth.json`, `mcp-oauth/`, or
package clones) and prints `git diff --stat` afterwards. Read the diff, then
commit. A new keeper is added by hand to both the list and the default-deny
`.gitignore` — which is structural hygiene, not a guard: nothing is tracked
unless allowlisted, so read the staged diff before every commit.
