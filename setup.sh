#!/usr/bin/env bash
# pawprint: imprint the curated pi-agent config onto a machine.
# COPIES pi-agent/* into the target dir — never symlinks: a tool writing its
# config through a symlink would write into this repo, and the leak vector
# returns. Target files that differ are backed up to <path>.bak-pawprint-<ts>.
#
# Usage: setup.sh [--dry-run] [--target DIR] [--imprint-only]
#   target default: $PAWPRINT_TARGET or ~/.pi/agent
#   --imprint-only: skip the machine-machinery section (pi/mise/packages/…)
set -euo pipefail
cd "$(dirname "$0")"

dry=0 imprint_only=0 target="${PAWPRINT_TARGET:-$HOME/.pi/agent}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1;;
    --imprint-only) imprint_only=1;;
    --target) shift; target="$1";;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
  shift
done
run() { if [ "$dry" = 1 ]; then echo "DRY: $*"; else "$@"; fi }

# ---------------------------------------------------------------- imprint ---
ts=$(date +%Y%m%d%H%M%S)
git ls-files -z 'pi-agent/' | while IFS= read -r -d '' rel; do
  dst="$target/${rel#pi-agent/}"
  src="$PWD/$rel"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "ok (same):     $dst"
    continue
  fi
  if [ -e "$dst" ]; then
    run cp -a "$dst" "$dst.bak-pawprint-$ts"
    echo "backed up:     $dst -> $dst.bak-pawprint-$ts"
  fi
  run mkdir -p "$(dirname "$dst")"
  run cp "$src" "$dst"
  echo "imprinted:     $dst"
done

# --------------------------------------- machine machinery (not the print) -
# Global, machine-level bootstrap. Skipped by --dry-run / --imprint-only /
# non-default --target. Prereqs: fish env vars set (see README), gh.
if [ "$dry" = 1 ] || [ "$imprint_only" = 1 ] || [ "$target" != "$HOME/.pi/agent" ]; then
  echo
  echo "machine machinery: SKIPPED (dry-run / --imprint-only / non-default target)"
  exit 0
fi

: "${CLOUDFLARE_ACCOUNT_ID:?set it in ~/.config/fish/conf.d first — see README}"
: "${CLOUDFLARE_GATEWAY_ID:?set it in ~/.config/fish/conf.d first — see README}"

command -v pi >/dev/null 2>&1 || npm install -g @earendil-works/pi-coding-agent

# toolchain (typecheck): pinned via mise; types resolve the LIVE pi through a symlink
command -v mise >/dev/null 2>&1 && (cd pi-agent && mise trust -q mise.toml 2>/dev/null; mise install)
ln -sfn "$(npm root -g)/@earendil-works" "$target/.pi-types"
command -v agent-browser >/dev/null 2>&1 || npm install -g agent-browser
agent-browser install >/dev/null 2>&1 || true   # browser runtime

# Packages: settings.json is the manifest. Skip any whose clone already exists —
# re-running `pi install` on a listed source risks rewriting filtered
# object-form entries (e.g. the kit's extension filters).
jq -r '.packages[] | if type == "object" then .source else . end' pi-agent/settings.json |
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
  cp pi-agent/ghostty/config.ghostty "$HOME/Library/Application Support/com.mitchellh.ghostty/config.ghostty"
  printf '# Canonical: pawprint repo pi-agent/ghostty/config.ghostty (installed by setup.sh)\n' \
    > "$HOME/.config/ghostty/config"
fi

if command -v gh >/dev/null 2>&1; then
  gh extension list 2>/dev/null | grep -q "gh-dash" || gh extension install dlvhdr/gh-dash || true
fi

echo "Done. Manual steps remain: /login cloudflare-ai-gateway (or env) · /mcp-auth per OAuth server · /trust per project — see README."
