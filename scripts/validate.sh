#!/usr/bin/env bash
# validate.sh — READ-ONLY audit: does the machine match the print?
# Per manifest file: same / drift / missing. Tools on PATH. Env vars SET
# (presence only, never values). Repo history free of secrets (gitleaks;
# missing scanner fails — this repo is public). Exit non-zero on any mismatch.
# Usage: validate.sh [--target DIR]   (default ~/.pi/agent)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

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

# A colored diff scans as clean: git's color settings inject ANSI codes into the
# patch gitleaks parses. `-c` (this variable) beats every config source; last wins.
export GIT_CONFIG_PARAMETERS="${GIT_CONFIG_PARAMETERS:+$GIT_CONFIG_PARAMETERS }'color.diff=never'"
# gitleaks exits 0 even when git itself fails ("0 commits scanned"), so a
# scan only counts as clean when it also logged no error.
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "secrets:       gitleaks MISSING — brew install gitleaks"; fail=1
elif err=$(gitleaks git --no-banner --no-color --redact -l error . 2>&1) && [ -z "$err" ]; then
  echo "secrets ok:    git history clean (gitleaks)"
else
  echo "secrets FAIL:  ${err:-leak in git history — see: gitleaks git --redact -v .}"; fail=1
fi

if [ "$fail" = 0 ]; then echo "VALID: machine matches the print"; else echo "INVALID: mismatches above" >&2; fi
exit "$fail"
