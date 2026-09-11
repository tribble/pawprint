#!/usr/bin/env bash
# pawprint: imprint the curated pi-agent config onto a machine.
# COPIES pi-agent/* into the target dir — never symlinks: a tool writing its
# config through a symlink would write into this repo, and the leak vector
# returns. Target files that differ are backed up to <path>.bak-pawprint-<ts>.
#
# Usage: setup.sh [--dry-run] [--target DIR] [--config-only]
#   target default: $PAWPRINT_TARGET or ~/.pi/agent
#   --config-only (alias --imprint-only): run ONLY the imprint — skip the
#   machine-machinery section (pi install/packages/mise/ghostty/gh-dash)
set -euo pipefail
cd "$(dirname "$0")"

dry=0 imprint_only=0 target="${PAWPRINT_TARGET:-$HOME/.pi/agent}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1;;
    --config-only|--imprint-only) imprint_only=1;;
    --target) shift; target="$1";;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
  shift
done
run() { if [ "$dry" = 1 ]; then echo "DRY: $*"; else "$@"; fi }

# ---------------------------------------------------------------- imprint ---
ts=$(date +%Y%m%d%H%M%S)
# manifest.json is the single source of truth for what imprints
jq -r '.files[]' manifest.json | while IFS= read -r rel; do
  dst="$target/$rel"
  src="$PWD/pi-agent/$rel"
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

# Imprint is additive/corrective, never destructive: it creates and
# overwrites (with backup), but never deletes. Removing config is a
# deliberate manual act on the machine.
echo
echo "Manual steps remain: /login cloudflare-ai-gateway (or env) · /mcp-auth per OAuth server · /trust per project — see README."

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

# (No legacy PATH-npm pi install: the pinned bootstrap below is the ONLY way
# pi gets installed. A foreign npm prefix rejecting global writes must not be
# able to abort setup before the launcher exists.)

# toolchain (typecheck): pinned via mise
command -v mise >/dev/null 2>&1 && (cd pi-agent && mise trust -q mise.toml 2>/dev/null; mise install)
command -v agent-browser >/dev/null 2>&1 || npm install -g agent-browser

# pi runtime: pi always runs on ONE pinned node, never the cwd's toolchain
# (direnv/flake/.nvmrc). Static launcher — it never resolves node from PATH.
# Both the pinned node AND pi installed under it must exist before the
# launcher is written — never publish a launcher that can't run.
node_ver=$(jq -r '.runtime.node // empty' manifest.json)
if [ -n "$node_ver" ]; then
  nroot="$HOME/.local/share/mise/installs/node/$node_ver"
  if [ ! -x "$nroot/bin/node" ] && command -v mise >/dev/null 2>&1; then
    mise install "node@$node_ver" || true   # verdict comes from the re-check
  fi
  if [ ! -x "$nroot/bin/node" ]; then
    echo "ERROR: pinned node $node_ver missing at $nroot (mise install failed or mise absent)" >&2
    exit 1
  fi
  pibundle="$nroot/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
  if [ ! -f "$pibundle" ]; then
    # Run npm-cli THROUGH the pinned interpreter with an explicit prefix.
    # The bin/npm shim execs bare `node` from PATH and npm derives its global
    # prefix from process.execPath — a foreign node earlier on PATH would
    # install pi into the wrong toolchain's prefix.
    if ! "$nroot/bin/node" "$nroot/lib/node_modules/npm/bin/npm-cli.js" \
        install -g --prefix "$nroot" @earendil-works/pi-coding-agent; then
      echo "ERROR: npm-cli.js install -g @earendil-works/pi-coding-agent failed under $nroot" >&2
      exit 1
    fi
  fi
  if [ ! -f "$pibundle" ]; then
    echo "ERROR: pi bundle still missing at $pibundle after install" >&2
    exit 1
  fi
  mkdir -p "$HOME/.local/bin"
  rm -f "$HOME/.local/bin/pi"   # replace an existing symlink, never follow it
  cat > "$HOME/.local/bin/pi" <<EOF
#!/bin/sh
# pawprint: pi runs on its pinned node, never the cwd's toolchain (direnv/flake/.nvmrc)
N="\$HOME/.local/share/mise/installs/node/$node_ver"
exec "\$N/bin/node" "\$N/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "\$@"
EOF
  chmod 755 "$HOME/.local/bin/pi"
  echo "launcher:      $HOME/.local/bin/pi -> node $node_ver"
  # types resolve the LIVE pi: .pi-types -> the PINNED install's scope dir
  # (tsconfig paths are .pi-types/pi-coding-agent/...). Never npm root -g —
  # that's the caller's toolchain and dangles on a fresh pinned install.
  ln -sfn "$nroot/lib/node_modules/@earendil-works" "$target/.pi-types"
fi
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
      "$HOME/.local/bin/pi" install "$src" --no-approve || echo "WARN: $src failed"
    fi
  done

# ghostty: canonical config lives in this repo; install to the path Ghostty honors
if [ -d /Applications/Ghostty.app ]; then
  mkdir -p "$HOME/Library/Application Support/com.mitchellh.ghostty"
  cp pi-agent/ghostty/config.ghostty "$HOME/Library/Application Support/com.mitchellh.ghostty/config.ghostty"
  mkdir -p "$HOME/.config/ghostty"
  printf '# Canonical: pawprint repo pi-agent/ghostty/config.ghostty (installed by setup.sh)\n' \
    > "$HOME/.config/ghostty/config"
fi

if command -v gh >/dev/null 2>&1; then
  gh extension list 2>/dev/null | grep -q "gh-dash" || gh extension install dlvhdr/gh-dash || true
fi

echo "Done."
