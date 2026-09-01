#!/usr/bin/env bash
# sync-back: the deliberate, reviewed act of copying a LIVE file back INTO
# the curated print. Run it, read `git diff`, then commit. Touches ONLY the
# exact known-safe paths below — never a wildcard sweep.
# Source dir override: PAWPRINT_TARGET (default ~/.pi/agent).
set -euo pipefail
cd "$(dirname "$0")/.."
target="${PAWPRINT_TARGET:-$HOME/.pi/agent}"

paths=(
  .gitignore
  AGENTS.md
  agents/reviewer-fable.md
  agents/reviewer-kimi.md
  agents/scout-kimi.md
  agents/worker-kimi.md
  extensions/auto-update.ts
  extensions/compaction-fallback.ts
  extensions/herdr-agent-state.ts
  extensions/herdr-fleet.ts
  extensions/preset.ts
  ghostty/config.ghostty
  mcp.json
  mise.toml
  models.json
  presets.json
  settings.json
  tsconfig.json
  # NEVER: auth.json, mcp-oauth/, .pi-types, git/ clones, or anything not
  # already in the curated print above. New keepers are added by hand.
)

for rel in "${paths[@]}"; do
  src="$target/$rel"
  [ -f "$src" ] || { echo "skip (no live file): $src"; continue; }
  if cmp -s "$src" "pi-agent/$rel"; then
    echo "ok (same):        pi-agent/$rel"
  else
    cp "$src" "pi-agent/$rel"
    echo "synced:           $src -> pi-agent/$rel"
  fi
done

echo
echo "Review what changed BEFORE committing:"
git diff --stat
