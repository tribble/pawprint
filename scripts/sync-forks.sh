#!/bin/bash
# sync-forks.sh — upstream (fitchmultz) → fork (tribble) sync.
# Default: REPORT divergence per fork (behind count + what's new upstream).
# --merge: merge upstream/main into the fork's main locally (never pushes).
# fork→machine is already automated (pi update pulls fork main); this script
# is the other half. Exit non-zero if any fork is behind, so it's checkable.
# ponytail: report-first; auto-merging upstream into patched files is how
# silent regressions ship, the merge stays a reviewed act.
set -euo pipefail

MERGE=0
[ "${1:-}" = "--merge" ] && MERGE=1

BEHIND_ANY=0
for pkg in pi-mcp-adapter pi-subagents; do
  d="$HOME/.pi/agent/git/github.com/tribble/$pkg"
  [ -d "$d" ] || { echo "$pkg: clone missing at $d"; BEHIND_ANY=1; continue; }
  git -C "$d" fetch -q upstream
  counts=$(git -C "$d" rev-list --left-right --count main...upstream/main)
  ahead="${counts%%	*}"; behind="${counts##*	}"
  echo "== $pkg: ahead $ahead, behind $behind"
  if [ "$behind" != "0" ]; then
    BEHIND_ANY=1
    git -C "$d" log --oneline main..upstream/main | sed 's/^/  new: /'
    if [ "$MERGE" = 1 ]; then
      if git -C "$d" merge --no-edit upstream/main; then
        echo "  merged upstream/main (review, test, push when ready)"
      else
        echo "  CONFLICTS — resolve in $d, then commit"
      fi
    fi
  fi
done
exit "$BEHIND_ANY"
