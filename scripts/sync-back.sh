#!/usr/bin/env bash
# sync-back: the deliberate, reviewed act of copying a LIVE file back INTO
# the curated print. Run it, read `git diff`, then commit. Touches ONLY the
# exact known-safe paths below — never a wildcard sweep.
# Source dir override: PAWPRINT_TARGET (default ~/.pi/agent).
set -euo pipefail
cd "$(dirname "$0")/.."
target="${PAWPRINT_TARGET:-$HOME/.pi/agent}"

# The list comes from manifest.json (single source of truth).
# NEVER add: auth.json, mcp-oauth/, .pi-types, git/ clones. New keepers enter
# the manifest by hand, after review.
paths=()
while IFS= read -r p; do paths+=("$p"); done < <(jq -r '.files[]' manifest.json)

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
