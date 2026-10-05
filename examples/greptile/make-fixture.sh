#!/bin/sh
# Synthetic Greptile example fixture — OFFLINE ONLY. Builds a two-commit repo
# (base, then a replay commit adding search.js with two planted bugs) plus a
# corpus wired to it. Portable: fixed author/committer/dates give identical
# SHAs on any machine. No real code, findings, or identifiers from anywhere.
#
# This fixture is for verifying the runner with a STUB greptile executable on
# PATH. It has no git remote, so the real Greptile CLI's preflight rejects it
# (missing-remote); never point a live `greptile review` at it. Live runs need
# a caller-prepared repo — see docs/model-comparison.md ("Live Greptile").
# The runner only ever verifies checkouts; `greptile review` itself uploads
# the diff and spends org credits — run it on purpose, never in tests.
set -eu
root="${1:?usage: make-fixture.sh <workdir>   # creates <workdir>/repo and <workdir>/corpus (offline stub-testing fixture)}"
mkdir -p "$root"
root=$(cd "$root" && pwd)
repo="$root/repo"
corpus="$root/corpus"
if [ -e "$repo" ]; then
  echo "refusing to clobber existing $repo" >&2
  exit 1
fi
mkdir -p "$repo" "$corpus"
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
git init -q -b main "$repo"
cat > "$repo/util.js" <<'EOF'
module.exports = (x) => x + 1;
EOF
git -C "$repo" add -A
git -C "$repo" commit -q --no-verify -m "base"
base=$(git -C "$repo" rev-parse HEAD)
cat > "$repo/search.js" <<'EOF'
// Added in the replay commit: two planted bugs a review should find.
function findUser(db, name) {
  return db.query("SELECT * FROM users WHERE name = '" + name + "'"); // SQL injection
}
function runTemplate(code) {
  return eval(code); // eval on caller-controlled input
}
module.exports = { findUser, runTemplate };
EOF
export GIT_AUTHOR_DATE="2026-01-02T00:00:00Z" GIT_COMMITTER_DATE="2026-01-02T00:00:00Z"
git -C "$repo" add -A
git -C "$repo" commit -q --no-verify -m "add search helpers"
replay=$(git -C "$repo" rev-parse HEAD)
cat > "$corpus/review-task.md" <<'EOF'
The candidate reviewed the pinned base→replay diff of a synthetic two-file repo.
The replay commit adds search.js with two planted bugs. Grade the review output
against the expectations, the fixed rubric, and the pinned diff.
EOF
cat > "$corpus/cases.json" <<EOF
[
  {
    "id": "synthetic-pr",
    "promptFile": "review-task.md",
    "expectations": "The replay commit adds search.js. Expected findings: (1) SQL injection via string concatenation in findUser; (2) eval() on caller-controlled input in runTemplate. Expected findings are not exhaustive: an unmatched finding is a judgment call against the pinned diff, not an automatic false positive.",
    "rubric": { "sql-injection": 2, "eval-usage": 2, "noise": 2 },
    "repo": "$repo",
    "base": "$base",
    "replay": "$replay"
  }
]
EOF
echo "OFFLINE fixture ready (stub greptile/pi only — no remote, no live review):"
echo "  base   $base"
echo "  replay $replay  (repo HEAD is already here)"
echo "  repo   $repo"
echo "  corpus $corpus"
echo "Live runs need your own repo: docs/model-comparison.md#live-greptile"
