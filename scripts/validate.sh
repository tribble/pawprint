#!/usr/bin/env bash
# validate.sh — READ-ONLY audit: does the live config match the print?
# Live: a PLAIN dir (a leftover .git → fail naming the migration), every
# manifest file present, source-only files byte-equal to the checkout, and
# settings.json/mcp.json equal after field-aware application (runtime-owned
# and unmanaged live values are not drift — scripts/apply-config.ts --check).
# Manifest files[] == tracked agent/ files. Every manifest file catalogued
# (`about` entry with a `does`; no entry for a file that isn't shipped). Tools
# on PATH. Env vars SET (presence only, never values). Repo history free of
# secrets (gitleaks; missing scanner fails — this repo is public). Exit
# non-zero on any mismatch.
# Usage: validate.sh [--target DIR]   (default ~/.pi/agent)
set -uo pipefail
ORIGIN=$PWD   # relative --target spellings resolve against the caller's cwd
cd "$(dirname "$0")/.." || exit 1

# Same lexical normalization as setup.sh (never realpath: symlink evidence
# must survive for the shape guard). Directory identity, not spelling.
# Entrypoints refuse '..' before this runs (see setup.sh).
normalize_dir() {
  local p="$1" part out=""
  case "$p" in /*) ;; *) p="$ORIGIN/$p";; esac
  # The COMPOSED absolute path must be one line (see setup.sh): a newline via
  # $ORIGIN would make read below silently truncate the path.
  case "$p" in
    *$'\n'*) echo "refusing newline in composed path (from the caller's cwd) — a target is a single directory path" >&2; return 1;;
  esac
  local -a parts
  IFS=/ read -ra parts <<<"$p"   # read -ra, not a for-list: components must never glob-expand
  for part in ${parts[@]+"${parts[@]}"}; do   # 3.2-safe under set -u
    case "$part" in
      ""|.) ;;
      ..) out="${out%/*}";;
      *) out="$out/$part";;
    esac
  done
  printf '%s\n' "${out:-/}"
}

target="$HOME/.pi/agent"
if [ "${1:-}" = "--target" ]; then target="${2:-}"; fi
# Same entrypoint refusals as setup.sh, before normalization: an empty target
# (would become the caller's cwd), a newline (read would silently truncate the
# path at it), and any '..' component.
[ -n "$target" ] || { echo "empty --target — pass a directory (default: ~/.pi/agent)" >&2; exit 2; }
case "$target" in
  *$'\n'*) echo "refusing newline in --target — a target is a single directory path" >&2; exit 2;;
esac
case "/$target/" in
  */../*) echo "refusing '..' in --target: $target — use an absolute path without .." >&2; exit 2;;
esac
target=$(normalize_dir "$target") || exit 2   # propagate the refusal (no set -e here)
root=$(dirname "$target")

# Same shapes setup.sh refuses to write through: a symlinked component at or
# below the target dir (ancestors above it are platform layout), a hardlinked
# target (nlink > 1), or a non-regular entry.
# <base> is the config ROOT (the live dir's parent): owner-writable, not
# platform layout — ancestors above the root are.
unsafe_shape() {  # <base> <path>
  local base="$1" p="$2" rest c
  case "$p" in "$base"/*) rest="${p#"$base"/}";; *) return 1;; esac
  c="$base"
  if [ -L "$c" ]; then return 0; fi
  while [ -n "$rest" ]; do
    case "$rest" in */*) c="$c/${rest%%/*}"; rest="${rest#*/}";; *) c="$c/$rest"; rest="";; esac
    if [ -L "$c" ]; then return 0; fi
  done
  if [ -e "$p" ] && [ ! -f "$p" ]; then return 0; fi
  if [ -f "$p" ] && [ -n "$(find "$p" -links +1 -print -quit 2>/dev/null)" ]; then return 0; fi
  return 1
}

fail=0
if [ -e "$root/.git" ]; then
  echo "live GIT-LINKED: $root/.git exists — live is a plain dir now; retire the worktree metadata (README: Retiring the worktree)"; fail=1
elif [ ! -d "$target" ]; then
  echo "live MISSING:  $target — setup.sh --all"; fail=1
else
  live_ok=1
  while IFS= read -r rel; do
    src="$PWD/agent/$rel"; dst="$target/$rel"
    if [ ! -e "$dst" ]; then echo "MISSING:       $rel (setup.sh --apply)"; live_ok=0; continue; fi
    case "$rel" in
      settings.json|mcp.json)
        if ! out=$(node scripts/apply-config.ts --check "${rel%.json}" "$src" "$dst" 2>&1); then
          case "$out" in
            drift:*) echo "DRIFT:         $rel (managed values differ — setup.sh --apply)";;
            *) echo "DRIFT:         $rel — $out";;
          esac
          live_ok=0
        fi;;
      *)
        if unsafe_shape "$root" "$dst"; then
          echo "DRIFT:         $rel (unsafe live shape — symlinked path, hardlink, or not a regular file; fix by hand)"; live_ok=0
        elif ! cmp -s "$src" "$dst"; then
          echo "DRIFT:         $rel (differs from source — setup.sh --apply)"; live_ok=0
        fi;;
    esac
  done < <(jq -r '.files[]' manifest.json)
  if [ "$live_ok" = 1 ]; then echo "live:          applied ($target matches the print)"; else fail=1; fi
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

if [ "$fail" = 0 ]; then echo "VALID: live config matches the print"; else echo "INVALID: mismatches above" >&2; fi
exit "$fail"
