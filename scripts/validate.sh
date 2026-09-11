#!/usr/bin/env bash
# validate.sh — READ-ONLY audit: does the machine match the print?
# Per manifest file: same / drift / missing. Tools on PATH. Env vars SET
# (presence only, never values). Exit non-zero on any mismatch.
# Usage: validate.sh [--target DIR]   (default ~/.pi/agent)
set -uo pipefail
cd "$(dirname "$0")/.."

target="$HOME/.pi/agent"
if [ "${1:-}" = "--target" ]; then target="$2"; fi

fail=0
while IFS= read -r rel; do
  src="pi-agent/$rel"
  dst="$target/$rel"
  if [ ! -f "$dst" ]; then
    echo "missing:       $rel"; fail=1
  elif cmp -s "$src" "$dst"; then
    echo "same:          $rel"
  else
    echo "drift:         $rel"; fail=1
  fi
done < <(jq -r '.files[]' manifest.json)

while IFS= read -r tool; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "tool ok:       $tool"
  else
    echo "tool MISSING:  $tool"; fail=1
  fi
done < <(jq -r '.tools[]' manifest.json)

while IFS= read -r var; do
  if [ -n "${!var:-}" ]; then
    echo "env ok:        $var"
  else
    echo "env MISSING:   $var"; fail=1
  fi
done < <(jq -r '.env[]' manifest.json)

if [ "$fail" = 0 ]; then echo "VALID: machine matches the print"; else echo "INVALID: mismatches above" >&2; fi
exit "$fail"
