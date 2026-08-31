#!/usr/bin/env bash
# pawprint: fresh-machine restore. Idempotent; safe to re-run.
# Full runbook: README.md. Prereqs: node 24 (mise), fish env vars set, gh.
set -euo pipefail
cd "$(dirname "$0")"

: "${CLOUDFLARE_ACCOUNT_ID:?set it in ~/.config/fish/conf.d first — see README}"
: "${CLOUDFLARE_GATEWAY_ID:?set it in ~/.config/fish/conf.d first — see README}"

# arm the versioned pre-commit guard (fresh clones don't inherit repo-local config)

command -v pi >/dev/null 2>&1 || npm install -g @earendil-works/pi-coding-agent

# toolchain (typecheck): pinned via mise; types resolve the LIVE pi through a symlink
command -v mise >/dev/null 2>&1 && { mise trust -q mise.toml 2>/dev/null; mise install; }
ln -sfn "$(npm root -g)/@earendil-works" .pi-types
command -v agent-browser >/dev/null 2>&1 || npm install -g agent-browser
agent-browser install >/dev/null 2>&1 || true   # browser runtime

# Packages: settings.json is the manifest. Skip any whose clone already exists —
# re-running `pi install` on a listed source risks rewriting filtered
# object-form entries (e.g. the kit's extension filters).
jq -r '.packages[] | if type == "object" then .source else . end' settings.json |
  while IFS= read -r src; do
    dir="git/$(printf '%s' "$src" | sed -E 's#^(git:|https?://|ssh://git@)##; s#:#/#; s#\.git$##')"
    if [ -d "$dir" ]; then
      echo "skip (present): $src"
    else
      pi install "$src" --no-approve || echo "WARN: $src failed"
    fi
  done

# ghostty: canonical config lives in this repo; install to the path Ghostty honors
if [ -d /Applications/Ghostty.app ]; then
  mkdir -p "$HOME/Library/Application Support/com.mitchellh.ghostty"
  cp ghostty/config.ghostty "$HOME/Library/Application Support/com.mitchellh.ghostty/config.ghostty"
  printf '# Canonical: ~/.pi/agent/ghostty/config.ghostty (installed by pawprint setup.sh)\n' \
    > "$HOME/.config/ghostty/config"
fi

if command -v gh >/dev/null 2>&1; then
  gh extension list 2>/dev/null | grep -q "gh-dash" || gh extension install dlvhdr/gh-dash || true
fi

echo "Done. Manual steps remain: /login cloudflare-ai-gateway (or env) · /mcp-auth per OAuth server · /trust per project — see README."
