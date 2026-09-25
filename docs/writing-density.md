# Writing density — what stops agents "hedging" (2026-09-18 → 09-24)

Owner's complaint: agent replies and docs are dense and over-explained; "hedging"; decisions get lost; had to ask one agent to summarize another. Trigger example:

> A directory is an entry point iff it has an index.ts; put one where a consumer of anything inside would want everything inside. Granularity lives in where the index.ts files are, not in config: changing a split later is adding or deleting one. export * is fine in them. ~310 to create; 7 exist.

## What "hedging" is, from six real cases

Sentences that protect the writer, not the reader: caveats attached to numbers, denials of claims nobody made ("Not a benefit: bundle size (there is no bundler)"), parentheticals pre-answering objections ("(verified)"), justifications of choices already made, narration of what was done before deciding, "honest"/"to be fair" disclaimers, restating what the reader said. Not uncertainty language. Sources: `failures-raw.md` in the tmp dir (session-log extracts, 2026-08-28 → 09-22).

The trigger example was **not** a writer failure: a coordinator relayed the owner's own chat Q&A ("can we split finer?" → "add or delete an index.ts, not config") as doc text. All three test arms reproduced it. Fix was a relay rule, not a cue.

## Experiments (all `pi -p --no-tools --thinking high`, 8 prompts from real failures, blind-graded)

Prompts: `writing-density/prompt-*.md` (6 failures F1–F6, 2 controls C1 recovery-steps, C2 warning-first). Harness: `run.sh` (argv elements must stay < ~800 B — longer ones get SIGKILLed on this machine with no log; `@file` avoids it).

**1. Cue placement** (fable-5.1; grader GPT) — `scores-1-*`

| arm | writer-protecting sentences (2 = none) | facts kept | total/8 |
|---|---|---|---|
| A live AGENTS.md only | 1.19 | 1.50 | 5.81 |
| B cue in system prompt | 1.62 | 1.44 | 6.88 |
| C cue appended to user turn | **1.88** | 1.31 | 7.12 |

F4 bait (context mentioned "no bundler"): A wrote "Not a benefit: …" 2/2, C 0/2. → shipped as `extensions/reader-cue.ts` (d2923ad): cue v1 on every user-role message, `context_with_system` hook, `/reader-cue on|off`.

**2. Cue v2** (added "narration before deciding", "justification for not acting") — `scores-2-*`: 1.50 vs v1's 1.75 re-scored. Worse. Rejected. Naming more patterns doesn't help; the cue is at ceiling. Grader noise ≈ ±0.13.

**3. Astra vs fable-5.1, same cue, same effort** — `scores-3-*`

| grader | fable total | Astra total |
|---|---|---|
| GPT | 6.12 | 7.69 |
| Claude (fable) | 7.81 | 7.19 |

Each grader preferred its own family and counted the other's sentences as protective. Graders can't settle this. Grader-independent: Astra shorter on 6/8 (F2 32 vs 117 words), 2.7× longer on the full-steps control. **Owner read three pairs blind** (`compare-owner-read.md`): F2 clear Astra, F3 Astra, C1 no winner ("OK to be verbose here"). Verdict: Astra.

## Decisions shipped

| commit | change |
|---|---|
| 0d6eb9a | AGENTS.md: "write only what the reader needs to act" rule |
| 5c28f2a | AGENTS.md rewritten under it, 2,145 → 1,682 words (ledger + 8-probe check) |
| d2923ad | `reader-cue.ts` per-turn cue; AGENTS.md: a chat answer is not artifact text |
| 0223a4c | `defaultModel` → gpt-6-astra (was fable-5-1; pane agents inherit it) |
| 2fce8ee | `worker` → kimi-k3 max; pane agents delegate implementation, never write code |
| 9f89cfc | review is cross-family: kimi code → `reviewer` (Astra); Astra prose → `reviewer-fable` |
| fe19134 | `fixer` → kimi-k3 medium |

Model map after: owner talks to Astra; Kimi writes code; Astra reviews code; Fable reviews Astra's prose (only remaining Fable role besides `writer`).

## Open

- Real-session durability of the cue (all probes were fresh `pi -p`). Check in a week: grep assistant turns for "(verified)", "Not a benefit", "to be fair".
- Astra in real sessions with tools and long context — untested; the switch is live, so the next week is the test.
- `writer` agent still pinned to fable-5-1.
- Vendor guidance that matched: fable-5.1 docs §Writing density — define the anti-pattern, put it in a user message, not the system prompt.

Raw outputs (64 replies) stayed in `~/.pi/agent/tmp/density-exp/out*/`; regenerate with `run.sh`.
