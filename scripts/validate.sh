#!/usr/bin/env bash
# validate.sh — READ-ONLY audit: does the machine match the print?
# Per manifest file: same / drift / missing. Tools on PATH. Env vars SET
# (presence only, never values). Exit non-zero on any mismatch.
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

# --- pinned pi runtime (manifest runtime.node) ----------------------------
# pi must run on ONE pinned node, never the cwd's toolchain (direnv/flake).
node_ver=$(jq -r '.runtime.node // empty' manifest.json)
if [ -z "$node_ver" ]; then
  echo "runtime FAIL:  manifest has no runtime.node"; fail=1
else
  nroot="$HOME/.local/share/mise/installs/node/$node_ver"
  lbin="$HOME/.local/bin"

  # (a) pinned node exists and reports exactly v<node_ver>
  if [ ! -x "$nroot/bin/node" ]; then
    echo "runtime FAIL:  pinned node missing: $nroot (mise install node@$node_ver)"; fail=1
  else
    got=$("$nroot/bin/node" --version 2>/dev/null)
    if [ "$got" = "v$node_ver" ]; then
      echo "runtime ok:    node $got (pinned)"
    else
      echo "runtime FAIL:  pinned node reports ${got:-nothing}, want v$node_ver"; fail=1
    fi
  fi

  # (b) pi installed under the pinned node: package.json readable, the
  # launcher's target bundle present, and engines.node accepting the pin.
  # Everything runs through the PINNED interpreter (verified by check (a));
  # range evaluated with pi's own bundled semver — never a half-parser. Any
  # read/eval failure is a FAIL, never a silent pass.
  pijson="$nroot/lib/node_modules/@earendil-works/pi-coding-agent/package.json"
  pibundle="$nroot/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
  semverdir="$nroot/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/semver"
  if [ ! -f "$pijson" ]; then
    echo "runtime FAIL:  pi not installed under pinned node ($pijson missing)"; fail=1
  elif [ ! -f "$pibundle" ]; then
    echo "runtime FAIL:  pi bundle missing under pinned node: $pibundle"; fail=1
  elif ! range=$("$nroot/bin/node" -e '
      const r = (require(process.argv[1]).engines || {}).node;
      process.stdout.write(r == null ? "__NONE__" : String(r));' "$pijson" 2>/dev/null); then
    echo "runtime FAIL:  cannot read engines from $pijson"; fail=1
  elif [ "$range" = "__NONE__" ]; then
    echo "runtime ok:    pi sets no engines.node range"
  elif [ ! -d "$semverdir" ]; then
    echo "runtime FAIL:  cannot evaluate engines range \"$range\" (semver missing under pinned pi)"; fail=1
  elif "$nroot/bin/node" -e 'process.exit(require(process.argv[1]).satisfies(process.argv[2], process.argv[3]) ? 0 : 1)' \
      "$semverdir" "$node_ver" "$range"; then
    echo "runtime ok:    pi engines.node ($range) accepts node $node_ver"
  else
    echo "runtime FAIL:  node $node_ver outside pi engines.node range \"$range\""; fail=1
  fi

  # (c) launcher exists, is the generated one (pins the node), and ~/.local/bin
  # precedes any mise node dir on PATH
  launcher="$lbin/pi"
  if [ ! -f "$launcher" ]; then
    echo "runtime FAIL:  $launcher missing (re-run setup.sh)"; fail=1
  elif [ ! -x "$launcher" ]; then
    echo "runtime FAIL:  $launcher not executable"; fail=1
  else
    # byte-exact compare against exactly what setup.sh writes — a substring
    # match would pass a drifted launcher, and $(...) would strip trailing
    # newlines; cmp on a mktemp file catches both
    want=$(mktemp "${TMPDIR:-/tmp}/pawprint-launcher.XXXXXX")
    trap 'rm -f "$want"' EXIT   # belt + suspenders; explicit rm -f below stays
    cat > "$want" <<EOF
#!/bin/sh
# pawprint: pi runs on its pinned node, never the cwd's toolchain (direnv/flake/.nvmrc)
N="\$HOME/.local/share/mise/installs/node/$node_ver"
exec "\$N/bin/node" "\$N/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "\$@"
EOF
    if cmp -s "$want" "$launcher"; then
      rm -f "$want"
      # whole-entry PATH walk: the first entry that IS $lbin or IS a mise node
      # dir decides; substring matching would let "$lbin-old" hide a mise dir
      path_state=absent
      oldIFS=$IFS; saved_flags=$-
      set -f; IFS=:
      for d in $PATH; do
        if [ "$d" = "$lbin" ]; then path_state=ok; break; fi
        case "$d" in
          *mise/installs/node*) path_state=shadowed; break;;
        esac
      done
      IFS=$oldIFS
      case "$saved_flags" in *f*) :;; *) set +f;; esac   # restore prior glob state
      case "$path_state" in
        ok)       echo "runtime ok:    launcher pinned; $lbin leads mise node dirs on PATH";;
        shadowed) echo "runtime FAIL:  a mise node dir precedes $lbin on PATH"; fail=1;;
        *)        echo "runtime FAIL:  $lbin not on PATH"; fail=1;;
      esac
    else
      rm -f "$want"
      echo "runtime FAIL:  launcher content drifted ($launcher — re-run setup.sh)"; fail=1
    fi
  fi

  # (d) command -v pi resolves to the launcher
  resolved=$(command -v pi 2>/dev/null || true)
  if [ "$resolved" = "$launcher" ]; then
    echo "runtime ok:    command -v pi -> $launcher"
  else
    echo "runtime FAIL:  command -v pi -> ${resolved:-nothing}, want $launcher"; fail=1
  fi
fi

if [ "$fail" = 0 ]; then echo "VALID: machine matches the print"; else echo "INVALID: mismatches above" >&2; fi
exit "$fail"
