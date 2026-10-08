#!/usr/bin/env bash
# pawprint: put the curated pi config on a machine. The live config dir
# (~/.pi/agent) is a PLAIN runtime/config directory — never a git worktree.
#   --all: the owner's machine: bootstrap the runtime (mise, pi), apply the
#   print + install its packages, then machine machinery (agent-browser,
#   ghostty, gh-dash).
#   --apply: the apply step + package installs (default live target), onto an
#   existing plain live dir. Never bootstraps pi.
#   --only: COPIES agent/<path> into the target dir (adopters) — never symlinks:
#   a tool writing its config through a symlink would write into this repo.
#   On an ALTERNATE --target, differing target files are backed up to
#   <path>.bak-pawprint-<ts>; on the default live target nothing is ever
#   copied out (no snapshots of live files, ever).
#
# Apply (--all/--apply): source-only files COPY from this checkout — source
# owns them; a differing live file is overwritten with no backup (no snapshots
# of the live dir, ever). settings.json/mcp.json — the files pi also writes —
# merge field-aware (scripts/apply-config.ts): source values win per key,
# runtime-owned and unmanaged live values survive, unchanged files are not
# rewritten. Symlinked path components, hardlinked or non-regular destinations,
# and malformed JSON are refused, never followed or overwritten. A git-linked
# target (a leftover .git) is refused: retire the worktree metadata first
# (README: "Retiring the worktree"). On the default live target the apply is
# followed by native package installs (`pi install <source> --no-approve` for
# every source in the applied settings.json; first failure exits nonzero, the
# config stays applied) — skipped truthfully by --dry-run / --config-only / an
# alternate target.
#
# Usage: setup.sh (--all | --apply | --only PATH...) [--dry-run] [--target DIR] [--config-only]
#        setup.sh --list
#   target default: $PAWPRINT_TARGET or ~/.pi/agent (--all needs it named agent/)
#   --all: apply the print + machine machinery
#   --apply: apply the print only
#   --only: copy just these manifest paths (no machinery)
#   --list: print the catalog (manifest.json `about`, one entry per file) — a
#   table on a TTY, JSON otherwise — and exit
#   --config-only (alias --imprint-only): run ONLY the apply/copy step — skip
#   package installs and the machine-machinery section (agent-browser, ghostty,
#   gh-dash, mise types symlink)
#   Bare setup.sh (no selector) refuses and points at the three above.
set -euo pipefail
ORIGIN=$PWD   # relative --target spellings resolve against the CALLER's cwd
cd "$(dirname "$0")"

# Lexical path normalization (never realpath: a symlinked component must still
# be there for the guard to find — resolve first and the evidence is gone).
# Absolutizes (relative → $ORIGIN), collapses //, /./, trailing slashes.
# Entrypoints refuse '..' before this runs: collapsing it lexically could name
# a different directory than the filesystem reaches through a symlink.
normalize_dir() {
  local p="$1" part out=""
  case "$p" in /*) ;; *) p="$ORIGIN/$p";; esac
  # The COMPOSED absolute path must be one line: a newline arriving via $ORIGIN
  # (a caller's cwd) would make read below silently truncate the path. The raw
  # '--target' refusal above covers a literal newline; this covers the join.
  case "$p" in
    *$'\n'*) echo "refusing newline in composed path (from the caller's cwd) — a target is a single directory path" >&2; return 1;;
  esac
  local -a parts
  IFS=/ read -ra parts <<<"$p"   # read -ra, not a for-list: components must never glob-expand
  for part in ${parts[@]+"${parts[@]}"}; do   # 3.2-safe under set -u
    case "$part" in
      ""|.) ;;
      ..) out="${out%/*}";;   # internal callers only ($HOME); entrypoints refuse '..'
      *) out="$out/$part";;
    esac
  done
  printf '%s\n' "${out:-/}"
}

# Directory identity, not spelling: normalized-string match, or same dev:inode
# when both exist. stat -L: identity FOLLOWS symlinks (a symlinked ~/.pi/agent
# is still the live dir; BSD stat lstats by default) — the WRITE guards are
# what refuse symlinked target paths, this compare only recognizes aliases.
same_dir() {  # <dir-a> <dir-b> → 0 same, 1 confirmed different, 2 UNKNOWN
  # capture-then-compare: a failing normalize inside a conditional's $() would
  # yield two empty strings — false identity with the live dir. Unknown is its
  # own status: the caller aborts rather than picking a backup rule on a guess.
  local na nb
  na=$(normalize_dir "$1") || return 2
  nb=$(normalize_dir "$2") || return 2
  if [ "$na" = "$nb" ]; then return 0; fi
  if [ ! -d "$1" ] || [ ! -d "$2" ]; then return 1; fi   # a missing dir is confirmed different
  local ai bi
  ai=$(stat -L -f '%d:%i' "$1" 2>/dev/null || stat -L -c '%d:%i' "$1" 2>/dev/null) || return 2
  bi=$(stat -L -f '%d:%i' "$2" 2>/dev/null || stat -L -c '%d:%i' "$2" 2>/dev/null) || return 2
  [ "$ai" = "$bi" ]
}

dry=0 imprint_only=0 list=0 all=0 apply=0 only=() target="${PAWPRINT_TARGET:-$HOME/.pi/agent}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1;;
    --config-only|--imprint-only) imprint_only=1;;
    --target) shift; target="$1";;
    --list) list=1;;
    --all) all=1;;
    --apply) apply=1;;
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
if [ "$all" = 0 ] && [ "$apply" = 0 ] && [ ${#only[@]} -eq 0 ]; then
  cat >&2 <<'EOF'
pawprint: this is one person's pi config print. See AGENTS.md / README.
  ./setup.sh --list                 what's in it
  ./setup.sh --only <path>…         install pieces (add --dry-run first)
  ./setup.sh --all                  owner only — apply the print to ~/.pi + machine bootstrap
EOF
  exit 2
fi
[ "$all" = 0 ] || { [ "$apply" = 0 ] && [ ${#only[@]} -eq 0 ]; } || { echo "--all, --apply and --only are exclusive" >&2; exit 2; }
[ "$apply" = 0 ] || [ ${#only[@]} -eq 0 ] || { echo "--all, --apply and --only are exclusive" >&2; exit 2; }

# Entrypoint refusals, BEFORE normalization erases the evidence: an empty
# target (would normalize to the caller's cwd), a newline (read stops at the
# first one — the rest of the path would silently vanish), and any '..'
# component (a lexical collapse could pick a different directory than the
# filesystem reaches through a symlink — refuse, never guess).
[ -n "$target" ] || { echo "empty --target — pass a directory (default: ~/.pi/agent)" >&2; exit 2; }
case "$target" in
  *$'\n'*) echo "refusing newline in --target — a target is a single directory path" >&2; exit 2;;
esac
case "/$target/" in
  */../*) echo "refusing '..' in --target: $target — use an absolute path without .." >&2; exit 2;;
esac

# Directory identity, not spelling: normalize once (lexically — symlink
# evidence survives), then every boundary below works on the canonical form.
target=$(normalize_dir "$target") || exit 2   # propagate the refusal (no silent empty target)

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

# Refuse an unsafe path shape before any read or write: a symlinked component
# at or below <base>, a non-regular final entry (never copy INTO a directory
# collision), or a hardlinked final entry (nlink > 1 — writing it would
# clobber the linked file). For the live side <base> is the config ROOT
# (dirname of the target, e.g. ~/.pi): it is owner-writable, not platform
# layout — ancestors above the root (e.g. macOS /var → /private/var) are.
guard_path() {  # <base> <path> <rel>
  local base="$1" p="$2" rel="$3" rest c
  case "$p" in "$base"/*) rest="${p#"$base"/}";; *) echo "REFUSED:       $rel — $p is not under $base" >&2; return 1;; esac
  c="$base"
  if [ -L "$c" ]; then echo "REFUSED:       $rel — symlinked path component: $c" >&2; return 1; fi
  while [ -n "$rest" ]; do
    case "$rest" in */*) c="$c/${rest%%/*}"; rest="${rest#*/}";; *) c="$c/$rest"; rest="";; esac
    if [ -L "$c" ]; then echo "REFUSED:       $rel — symlinked path component: $c" >&2; return 1; fi
  done
  if [ -e "$p" ] && [ ! -f "$p" ]; then echo "REFUSED:       $rel — not a regular file: $p" >&2; return 1; fi
  if [ -f "$p" ] && [ -n "$(find "$p" -links +1 -print -quit)" ]; then
    echo "REFUSED:       $rel — hardlinked elsewhere: $p" >&2; return 1
  fi
  return 0
}

guard_paths() {  # <src> <dst> <rel>
  guard_path "$PWD/agent" "$1" "$3" || return 1
  guard_path "$(dirname "$target")" "$2" "$3" || return 1
  return 0
}

# Copy one source-only manifest file into the target dir.
# $2 nonempty: back up a differing target file first (--only on an alternate
# target, adopters). $2 empty: overwrite (--all/--apply — source owns these
# files; no snapshots).
imprint_copy() {  # <rel> <backup-ts|"">
  local rel="$1" ts="$2" dst="$target/$1" src="$PWD/agent/$1"
  guard_paths "$src" "$dst" "$rel" || return 1
  if [ ! -f "$src" ]; then
    echo "REFUSED:       $rel — source is missing or not a regular file: $src" >&2
    return 1
  fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "ok (same):     $dst"
    return 0
  fi
  if [ -n "$ts" ] && [ -e "$dst" ]; then
    run cp -a "$dst" "$dst.bak-pawprint-$ts"
    echo "backed up:     $dst -> $dst.bak-pawprint-$ts"
  fi
  run mkdir -p "$(dirname "$dst")"
  run cp -a "$src" "$dst"     # -a: preserve modes (exec bits) + timestamps
  echo "imprinted:     $dst"
}

# settings.json/mcp.json — the files pi writes too — merge field-aware, so
# runtime-owned and unmanaged live values survive (scripts/apply-config.ts,
# which also resolves pi's installed package: PAWPRINT_PI_PKG, mise, npm -g,
# or a PATH-installed pi). A settings apply on a machine without pi fails with
# a clear message — run --all, which bootstraps the runtime first.
apply_json() {  # <rel> (settings.json|mcp.json)
  local rel="$1" kind="${1%%.json}"
  if [ ! -f "$PWD/agent/$rel" ]; then
    # a selected file that cannot be applied must not report success
    echo "REFUSED:       $rel — source is missing or not a regular file: $PWD/agent/$rel" >&2
    return 1
  fi
  run node "$PWD/scripts/apply-config.ts" "$kind" "$PWD/agent/$rel" "$target/$rel"
}

# ------------------------------------------------------- --only: copy in ---
if [ ${#only[@]} -gt 0 ]; then
  # Backups are for adopters onto an ALTERNATE target; on the owner's live
  # dir — however spelled — --only never copies a live file (no snapshots).
  # Backups only on CONFIRMED difference: an identity error aborts — guessing
  # either way is prohibited (a live backup, or an adopter file overwritten
  # without the backup it was promised).
  ts=""
  rc=0
  same_dir "$target" "$HOME/.pi/agent" || rc=$?
  case "$rc" in
    0) ;;
    1) ts=$(date +%Y%m%d%H%M%S);;
    *) echo "cannot confirm whether the target is the live dir — refusing to copy" >&2; exit 1;;
  esac
  # A --only naming settings.json/mcp.json needs pi's package (native settings
  # writer, MCP merge validation) — resolve it before the first SELECTED
  # write; source-only selections need no runtime. --dry-run skips resolution.
  if [ "$dry" = 0 ] && printf '%s\n' "${only[@]}" | grep -qE '^(settings|mcp)\.json$'; then
    PAWPRINT_PI_PKG=$(node "$PWD/scripts/apply-config.ts" --resolve-pi)
    export PAWPRINT_PI_PKG
  fi
  printf '%s\n' "${only[@]}" | while IFS= read -r rel; do
    case "$rel" in
      settings.json|mcp.json) apply_json "$rel";;
      *) imprint_copy "$rel" "$ts";;
    esac
  done
  echo
  echo "machine machinery: SKIPPED (--only)"
  exit 0
fi

# ------------------------------- runtime bootstrap (fresh machines, --all) ---
# The settings/mcp apply needs pi's installed package, which a fresh machine
# does not have yet — establish the runtime BEFORE the apply. --apply/--only
# never bootstrap. Same conditions as the machinery below (the rest of it — the
# tools — still runs after the apply, against the applied settings).
if [ "$all" = 1 ] && [ "$dry" = 0 ] && [ "$imprint_only" = 0 ] && [ "$target" = "$HOME/.pi/agent" ]; then
  command -v mise >/dev/null 2>&1 && { mise trust -q mise.toml 2>/dev/null; mise install; }
  command -v pi >/dev/null 2>&1 || npm install -g @earendil-works/pi-coding-agent
fi

# -------------------------------------- --all / --apply: plain live dir ---
if [ "$all" = 1 ]; then
  [ "$(basename "$target")" = agent ] || { echo "--all: target must be an agent/ dir (got $target)" >&2; exit 2; }
fi
root=$(dirname "$target")
if [ -e "$root/.git" ]; then
  echo "$root is still git-linked — retire the worktree metadata first (README: Retiring the worktree), then re-run" >&2
  exit 1
fi
# settings.json/mcp.json both need pi's installed package: resolve it ONCE —
# modules and exports checked by apply-config.ts --resolve-pi — before ANY
# manifest write, then reuse it for every per-file apply. --all's bootstrap
# above supplies it on a fresh machine; --apply never bootstraps, so a missing
# pi refuses here with nothing written. --dry-run skips resolution.
if [ "$dry" = 0 ]; then
  PAWPRINT_PI_PKG=$(node "$PWD/scripts/apply-config.ts" --resolve-pi)
  export PAWPRINT_PI_PKG
fi
jq -r '.files[]' manifest.json | while IFS= read -r rel; do
  case "$rel" in
    settings.json|mcp.json) apply_json "$rel";;
    *) imprint_copy "$rel" "";;
  esac
done
# ----------------------------------- package install (applied settings) ---
# The apply above made the live settings.json's package list the source's
# (arrays replace wholesale). Install every declared source natively:
# `pi install <source> --no-approve` reconciles a clone to the configured
# git/npm pin and keeps object-form resource filters. No skip-if-clone-present,
# no warn-and-continue: a stale clone at the wrong pin is what the native
# install fixes, and the FIRST failure exits nonzero — config applied, packages
# incomplete, never claim success.
# PI_CODING_AGENT_DIR binds pi to THIS target. --apply never bootstraps pi
# (--all's bootstrap did, above); a missing pi surfaces as the first failed
# install. Skipped truthfully on --dry-run / --config-only / a non-default
# target.
if [ "$dry" = 1 ] || [ "$imprint_only" = 1 ] || [ "$target" != "$HOME/.pi/agent" ]; then
  echo
  echo "package installation: SKIPPED (dry-run / --config-only / non-default target)"
else
  pkg_sources=$(jq -r '.packages[]? | if type == "object" then .source else . end' "$target/settings.json")
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    if ! PI_CODING_AGENT_DIR="$target" pi install "$src" --no-approve; then
      echo "config applied, but package installation INCOMPLETE — failed source: $src" >&2
      if [ "$all" = 1 ]; then mode=all; else mode=apply; fi
      echo "retry: $0 --$mode   # re-applies the config, then re-runs the remaining setup" >&2
      exit 1
    fi
  done <<< "$pkg_sources"
fi
if [ "$apply" = 1 ]; then
  echo
  echo "machine machinery: SKIPPED (--apply)"
  exit 0
fi
echo
echo "Manual steps remain: /login cloudflare-ai-gateway (or env) · pi mcp login <server> per OAuth server · /trust per project — see README."

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

# pi and the mise toolchain were installed by the bootstrap above (or existed).
# toolchain (typecheck): pinned via mise.toml at the repo root; tsconfig resolves
# pi's types through .pi-types → the mise-installed pi's package store (also has
# @types/node). `npm run types` refreshes the symlink in any checkout.
command -v mise >/dev/null 2>&1 && pi_dir="$(mise where npm:@earendil-works/pi-coding-agent)" && ln -sfn "$pi_dir/node_modules/.mise/node_modules" .pi-types || true
command -v agent-browser >/dev/null 2>&1 || npm install -g agent-browser
agent-browser install >/dev/null 2>&1 || true   # browser runtime

# ghostty: canonical config lives in this repo; install to the path Ghostty honors
if [ -d /Applications/Ghostty.app ]; then
  mkdir -p "$HOME/Library/Application Support/com.mitchellh.ghostty"
  cp ghostty/config.ghostty "$HOME/Library/Application Support/com.mitchellh.ghostty/config.ghostty"
  mkdir -p "$HOME/.config/ghostty"
  printf '# Canonical: pawprint repo ghostty/config.ghostty (installed by setup.sh)\n' \
    > "$HOME/.config/ghostty/config"
fi

if command -v gh >/dev/null 2>&1; then
  gh extension list 2>/dev/null | grep -q "gh-dash" || gh extension install dlvhdr/gh-dash || true
fi

echo "Done."
