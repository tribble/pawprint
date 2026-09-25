#!/bin/bash
# 3 arms × 8 prompts × 2 gens, sequential. Every argv element < 800 B (EDR kills longer ones): prompts via @file.
# Paths point at ~/.pi/agent/tmp/density-exp (scratch). To re-run: copy prompt-*.md → prompts/<name>.md, cue-v1-live.md → cue.md,
# build prompts-c/<name>.md = prompt + blank line + cue, then run. Arm C is the shipped placement.
set -u
cd ~/work/density-scratch
D=~/.pi/agent/tmp/density-exp
COMMON=(-p --no-tools --no-extensions --no-skills --no-prompt-templates --no-session --thinking high --model cloudflare-ai-gateway/claude-fable-5-1)
for p in $D/prompts/*.md; do
  name=$(basename $p .md)
  for g in 1 2; do
    for arm in A B C; do
      out=$D/out/$name.$arm.$g.md
      [ -s "$out" ] && continue
      case $arm in
        A) pi "${COMMON[@]}" @$p > "$out" 2>$out.err ;;
        B) pi "${COMMON[@]}" --append-system-prompt $D/cue.md @$p > "$out" 2>$out.err ;;
        C) pi "${COMMON[@]}" @$D/prompts-c/$name.md > "$out" 2>$out.err ;;
      esac
      rc=$?; echo "$name $arm $g: $(wc -w < $out)w rc=$rc"
    done
  done
done
