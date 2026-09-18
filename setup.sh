#!/usr/bin/env bash
# pawprint: put the curated pi config on a machine.
#   --only: COPIES agent/<path> into the target dir (adopters) — never symlinks:
#   a tool writing its config through a symlink would write into this repo.
#   Target files that differ are backed up to <path>.bak-pawprint-<ts>.
#   --all: the owner's machine. The target's parent (~/.pi) becomes a locked,
#   sparse (cone: agent) worktree of this repo on main — the live config IS the
#   checkout. Files already there and equal are adopted, missing ones checked
#   out, a differing one is DRIFT: nothing is overwritten and the run stops.
#
# Usage: setup.sh (--all | --only PATH...) [--dry-run] [--target DIR] [--config-only]
#        setup.sh --list
#   target default: $PAWPRINT_TARGET or ~/.pi/agent (--all needs it named agent/)
#   --all: worktree at dirname(target) + machine machinery
#   --only: copy just these manifest paths (no machinery)
#   --list: print the catalog (manifest.json `about`, one entry per file) — a
#   table on a TTY, JSON otherwise — and exit
#   --config-only (alias --imprint-only): run ONLY the worktree/copy step — skip
#   the machine-machinery section (pi install/packages/mise/ghostty/gh-dash)
#   Bare setup.sh (no selector) refuses and points at the three above.
set -euo pipefail
cd "$(dirname "$0")"

dry=0 imprint_only=0 list=0 all=0 only=() target="${PAWPRINT_TARGET:-$HOME/.pi/agent}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1;;
    --config-only|--imprint-only) imprint_only=1;;
    --target) shift; target="$1";;
    --list) list=1;;
    --all) all=1;;
    --only)  # every following arg up to the next --flag is a path
      shift; imprint_only=1
      while [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; do only+=("$1"); shift; done
      [ ${#only[@]} -gt 0 ] || { echo "--only needs at least one manifest path (see --list)" >&2; exit 2; }
      continue;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
  shift
done
run() { if [ "$dry" = 1 ]; then echo "DRY: $*"; else "$@"; fi }

if [ "$list" = 1 ]; then
  if [ -t 1 ]; then
    maxpath=$(jq -r '.files[]' manifest.json | awk '{ if (length > m) m = length } END { print m+0 }')
    printf '%-*s  P  does\n' "$maxpath" "path"
    jq -r '.files[] as $p | .about[$p] | "\($p)\t\(.personal // false | if . then "P" else " " end)\t\(.does)"' manifest.json |
      while IFS=$'\t' read -r pth p does; do printf '%-*s  %s  %s\n' "$maxpath" "$pth" "$p" "$does"; done
  else
    jq '[.files[] as $p | .about[$p] | {path: $p, does, needs: (.needs // []), personal: (.personal // false)}]' manifest.json
  fi
  exit 0
fi

# No selector: a visitor who runs the bare script must not get the full imprint.
if [ "$all" = 0 ] && [ ${#only[@]} -eq 0 ]; then
  cat >&2 <<'EOF'
pawprint: this is one person's pi config print. See AGENTS.md / README.
  ./setup.sh --list                 what's in it
  ./setup.sh --only <path>…         install pieces (add --dry-run first)
  ./setup.sh --all                  owner only — makes ~/.pi a worktree of this repo
EOF
  exit 2
fi
[ "$all" = 0 ] || [ ${#only[@]} -eq 0 ] || { echo "--all and --only are exclusive" >&2; exit 2; }

# --only: refuse before anything is copied if a path is not in the manifest;
# warn on each file that encodes tribble's own choices, then proceed.
if [ ${#only[@]} -gt 0 ]; then
  # JSON-quoted on purpose: an empty arg must surface as "" — raw, it would vanish in $(...)
  # and then imprint the target dir itself (cp -a of the whole dir into its own backup).
  unknown=$(printf '%s\n' "${only[@]}" | jq -R --slurpfile m manifest.json -c 'select(IN($m[0].files[]) | not)')
  [ -z "$unknown" ] || { echo "not in manifest.json files[]: $(printf '%s' "$unknown" | paste -sd' ' -)" >&2; exit 2; }
  printf '%s\n' "${only[@]}" | jq -R --slurpfile m manifest.json -r 'select($m[0].about[.].personal == true)' |
    while IFS= read -r rel; do echo "$rel encodes tribble's own choices — read it before you keep it" >&2; done
fi

# ---------------------------------------------------------- this checkout ---
# Pre-commit secret scan (.githooks/pre-commit): repo-local git config, not a
# machine change, so it runs in every mode. Skipped in a copy without .git.
# Read before write: the test suite runs this concurrently against one .git,
# and two writers race for config.lock — if we lose, the winner set the same value.
if [ -e .git ] && [ "$(git config core.hooksPath)" != .githooks ]; then
  run git config core.hooksPath .githooks || { sleep 1; [ "$(git config core.hooksPath)" = .githooks ]; }
fi

# ------------------------------------------------------- --only: copy in ---
if [ ${#only[@]} -gt 0 ]; then
  ts=$(date +%Y%m%d%H%M%S)
  printf '%s\n' "${only[@]}" | while IFS= read -r rel; do
    dst="$target/$rel"
    src="$PWD/agent/$rel"
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
      echo "ok (same):     $dst"
      continue
    fi
    if [ -e "$dst" ]; then
      run cp -a "$dst" "$dst.bak-pawprint-$ts"
      echo "backed up:     $dst -> $dst.bak-pawprint-$ts"
    fi
    [ -f "$src" ] || continue   # index lists it but worktree lacks it
    run mkdir -p "$(dirname "$dst")"
    run cp -a "$src" "$dst"     # -a: preserve modes (exec bits) + timestamps
    echo "imprinted:     $dst"
  done
  echo
  echo "machine machinery: SKIPPED (--only)"
  exit 0
fi

# ------------------------------------------------- --all: live worktree ---
# The live config dir must be the cone (agent/) of the worktree at its parent.
[ "$(basename "$target")" = agent ] || { echo "--all: target must be an agent/ dir (got $target)" >&2; exit 2; }
root=$(dirname "$target")
git=(git -C "$root")
common=$(git rev-parse --path-format=absolute --git-common-dir)
if [ "$("${git[@]}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" != "$common" ]; then
  [ -e "$root/.git" ] && { echo "$root is a git checkout of something else — not touching it" >&2; exit 1; }
  if [ "$dry" = 1 ]; then echo "DRY: make $root a locked sparse worktree (agent/) of $PWD on main"; exit 0; fi
  # The ignore policy is what keeps auth.json & co out of git: before .git is
  # attached, the live tree must carry either no .gitignore or exactly main's,
  # and no nested one under agent/ (a nested file can un-ignore anything).
  if [ -e "$root/.gitignore" ] && ! cmp -s "$root/.gitignore" <(git show main:.gitignore); then
    echo "DRIFT:         .gitignore (differs from main's; the live ignore policy must be main's) — not attaching" >&2; exit 1
  fi
  nested=$([ ! -d "$target" ] || find "$target" -name .gitignore)
  [ -z "$nested" ] || { sed "s#^$root/#DRIFT:         #; s#\$# (nested ignore file overrides the allowlist) — not attaching#" <<<"$nested" >&2; exit 1; }
  # main can be checked out once; this checkout gives it up (no file changes).
  [ "$(git branch --show-current)" != main ] || { git switch -q --detach; echo "detached $PWD from main: main now lives in $root"; }
  # `worktree add` wants an empty path; the live dir is not. Add at a scratch
  # path, move the .git pointer file over, let git repair the back-link.
  mkdir -p "$root"
  scratch=$(mktemp -d "$root/pi.XXXXXX")
  git worktree add -q --no-checkout --lock --reason "live pi config" "$scratch" main || { rmdir "$scratch"; exit 1; }
  mv "$scratch/.git" "$root/.git" && rmdir "$scratch"
  git worktree repair "$root" >/dev/null 2>&1
  "${git[@]}" sparse-checkout set --cone agent .githooks   # .githooks: the gitleaks pre-commit hook
  "${git[@]}" reset -q   # index = main, files untouched
  [ -e "$root/.gitignore" ] || "${git[@]}" checkout -q -- .gitignore   # ignore policy in place before anything else
  echo "worktree:      $root (main, sparse: agent/ .githooks/, locked)"
elif [ "$dry" = 0 ] && "${git[@]}" rev-parse -q --verify '@{u}' >/dev/null 2>&1; then
  "${git[@]}" pull -q --ff-only
fi
[ "$("${git[@]}" branch --show-current)" = main ] || { echo "$root is not on main — fix by hand" >&2; exit 1; }
# Missing files first. "Missing" to git also covers a directory or symlink at
# the path, or a symlink on the way to it: checkout would replace those, so
# they are DRIFT instead. Only a truly absent path is checked out.
drift=""
while IFS= read -r f; do
  p="$root"; blocked=""
  for seg in ${f//\// }; do
    p="$p/$seg"
    if [ -L "$p" ] || { [ "$p" = "$root/$f" ] && [ -e "$p" ]; } || { [ -e "$p" ] && [ ! -d "$p" ]; }; then blocked="$p"; break; fi
  done
  if [ -n "$blocked" ]; then drift+="$f (in the way: $blocked)"$'\n'; continue; fi
  run "${git[@]}" checkout -q -- "$f"; echo "checked out:   $root/$f"
done < <("${git[@]}" diff --name-only --diff-filter=D)
# Never overwrite a live file: a differing one is DRIFT, resolve it in $root with git.
drift+=$("${git[@]}" status --porcelain | grep -v '^ D ' | cut -c4- || true)
if [ -n "$drift" ]; then
  sed '/^$/d; s/^/DRIFT:         /' <<<"$drift" >&2
  echo "resolve in $root (git add -p / git checkout -- <file>), then re-run" >&2
  exit 1
fi
echo "live:          clean ($root on main $("${git[@]}" rev-parse --short HEAD))"

echo
echo "Manual steps remain: /login cloudflare-ai-gateway (or env) · /mcp-auth per OAuth server · /trust per project — see README."

# --------------------------------------- machine machinery (not the print) -
# Global, machine-level bootstrap. Skipped by --dry-run / --config-only /
# non-default --target. Prereqs: fish env vars set (see README), gh.
if [ "$dry" = 1 ] || [ "$imprint_only" = 1 ] || [ "$target" != "$HOME/.pi/agent" ]; then
  echo
  echo "machine machinery: SKIPPED (dry-run / --config-only / non-default target)"
  exit 0
fi

: "${CLOUDFLARE_ACCOUNT_ID:?set it in ~/.config/fish/conf.d first — see README}"
: "${CLOUDFLARE_GATEWAY_ID:?set it in ~/.config/fish/conf.d first — see README}"

command -v pi >/dev/null 2>&1 || npm install -g @earendil-works/pi-coding-agent

# toolchain (typecheck): pinned via mise; types resolve the LIVE pi through a symlink
# Inputs below come from $target — the live main checkout — not from this (possibly stale) checkout.
command -v mise >/dev/null 2>&1 && (cd "$target" && mise trust -q mise.toml 2>/dev/null; mise install)
ln -sfn "$(npm root -g)/@earendil-works" "$target/.pi-types"
command -v agent-browser >/dev/null 2>&1 || npm install -g agent-browser
agent-browser install >/dev/null 2>&1 || true   # browser runtime

# Packages: settings.json is the manifest. Skip any whose clone already exists —
# re-running `pi install` on a listed source risks rewriting filtered
# object-form entries (e.g. the kit's extension filters).
jq -r '.packages[] | if type == "object" then .source else . end' "$target/settings.json" |
  while IFS= read -r src; do
    dir="$target/git/$(printf '%s' "$src" | sed -E 's#^(git:|https?://|ssh://git@)##; s#:#/#; s#\.git$##')"
    if [ -d "$dir" ]; then
      echo "skip (present): $src"
    else
      pi install "$src" --no-approve || echo "WARN: $src failed"
    fi
  done

# ghostty: canonical config lives in this repo; install to the path Ghostty honors
if [ -d /Applications/Ghostty.app ]; then
  mkdir -p "$HOME/Library/Application Support/com.mitchellh.ghostty"
  cp "$target/ghostty/config.ghostty" "$HOME/Library/Application Support/com.mitchellh.ghostty/config.ghostty"
  mkdir -p "$HOME/.config/ghostty"
  printf '# Canonical: pawprint repo agent/ghostty/config.ghostty (installed by setup.sh)\n' \
    > "$HOME/.config/ghostty/config"
fi

if command -v gh >/dev/null 2>&1; then
  gh extension list 2>/dev/null | grep -q "gh-dash" || gh extension install dlvhdr/gh-dash || true
fi

echo "Done."
