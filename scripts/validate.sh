#!/usr/bin/env bash
# validate.sh — READ-ONLY audit: is the live config the checkout it should be?
# Live: dirname(target) is a locked worktree of this repo, on main, status
# clean, main == origin/main. Manifest files[] == tracked agent/ files. Every
# manifest file catalogued (`about` entry with a `does`; no entry for a file
# that isn't shipped). Tools on PATH. Env vars SET (presence only, never
# values). Repo history free of secrets (gitleaks; missing scanner fails —
# this repo is public). Exit non-zero on any mismatch.
# Usage: validate.sh [--target DIR]   (default ~/.pi/agent)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

target="$HOME/.pi/agent"
if [ "${1:-}" = "--target" ]; then target="$2"; fi
root=$(dirname "$target")
git=(git -C "$root")

fail=0
mine=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
if [ -z "$mine" ] || [ "$("${git[@]}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" != "$mine" ]; then
  echo "live NOT WORKTREE: $root is not a worktree of this repo — setup.sh --all"; fail=1
else
  branch=$("${git[@]}" branch --show-current); sha=$("${git[@]}" rev-parse --short HEAD)
  live_ok=1
  [ "$branch" = main ] || { echo "live BRANCH:   $branch (want main)"; live_ok=0; }
  [ -e "$("${git[@]}" rev-parse --path-format=absolute --git-dir)/locked" ] ||
    { echo "live UNLOCKED: git -C $root worktree lock --reason 'live pi config' $root"; live_ok=0; }
  # pi stamps lastChangelogVersion into settings.json on every upgrade: when that
  # is the only change in the whole worktree, name the keep command instead of DRIFT.
  status=$("${git[@]}" status --porcelain)
  stamp=""
  if [ "$status" = " M agent/settings.json" ]; then
    changed=$("${git[@]}" diff -U0 agent/settings.json | grep '^[-+][^-+]')
    if [ -n "$changed" ] && ! printf '%s\n' "$changed" | grep -qv '"lastChangelogVersion"'; then
      stamp=$(printf '%s\n' "$changed" | sed -n 's/^+.*"lastChangelogVersion": *"\([^"]*\)".*/\1/p' | head -1)
    fi
  fi
  if [ -n "$stamp" ]; then
    echo "live:          pi wrote agent/settings.json (lastChangelogVersion) — keep: git -C $root add -p agent/settings.json && git -C $root commit -m 'pi $stamp stamp' && git -C $root push"
  else
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      echo "DRIFT:         ${line:3}"; live_ok=0
    done <<<"$status"
  fi
  if "${git[@]}" rev-parse -q --verify origin/main >/dev/null; then
    ahead=$("${git[@]}" rev-list --count origin/main..HEAD); behind=$("${git[@]}" rev-list --count HEAD..origin/main)
    [ "$ahead" = 0 ] || { echo "live UNPUSHED: $ahead commit(s) — git -C $root push"; live_ok=0; }
    [ "$behind" = 0 ] || { echo "live BEHIND:   $behind commit(s) — git -C $root pull --ff-only"; live_ok=0; }
  else
    echo "live NO ORIGIN: origin/main unknown"; live_ok=0
  fi
  if [ "$live_ok" != 1 ]; then fail=1; elif [ -z "$stamp" ]; then echo "live:          clean ($branch $sha == origin/main)"; fi
fi

# manifest.json files[] is the adopters' catalog: exactly the tracked agent/ files
if diff=$(diff <(jq -r '.files[]' manifest.json | sort) <(git ls-files agent/ | sed 's#^agent/##' | sort)); then
  echo "manifest ok:   files[] == git ls-files agent/"
else
  echo "manifest DIFF: files[] vs git ls-files agent/ (< manifest, > tracked)"; echo "$diff" | grep '^[<>]'; fail=1
fi

# Catalog (setup.sh --list): every shipped file has an `about` with a `does`
# (≤ 80 chars), and `about` names nothing that isn't shipped.
catalog_ok=1
while IFS= read -r rel; do
  echo "about MISSING: $rel"; fail=1 catalog_ok=0
done < <(jq -r '.about as $a | .files[] | select(($a[.].does // "") == "")' manifest.json)
while IFS= read -r line; do
  echo "about LONG:    $line"; fail=1 catalog_ok=0
done < <(jq -r '.about as $a | .files[] | select(($a[.].does // "") | length > 80) | "\(.) (\($a[.].does|length) chars)"' manifest.json)
while IFS= read -r rel; do
  echo "about ORPHAN:  $rel (not in files[])"; fail=1 catalog_ok=0
done < <(jq -r '.files as $f | (.about // {}) | keys[] | select(IN($f[]) | not)' manifest.json)
[ "$catalog_ok" = 1 ] && echo "about ok:      every manifest file is catalogued (does ≤ 80 chars)"

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

if [ "$fail" = 0 ]; then echo "VALID: live config is the checkout"; else echo "INVALID: mismatches above" >&2; fi
exit "$fail"
