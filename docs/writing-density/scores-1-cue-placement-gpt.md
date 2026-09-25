## C1 — Recovery

| Reply | Answer-first | Writer-protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| T | 2 | 1 | 2 | 2 | 7 |
| P | 2 | 1 | 1 | 2 | 6 |
| U | 2 | 2 | 1 | 2 | 7 |
| S | 2 | 2 | 0 | 1 | 5 |
| Q | 2 | 2 | 0 | 2 | 6 |
| R | 2 | 2 | 1 | 2 | 7 |

Best: **T**, tied on points but most complete — “Untracked file the branch also adds: `mv` it aside.” Worst: **S** — “`git -C ~/.pi reset --hard origin/main`” can destroy work, and “so nothing is live yet” misstates the deployed file's availability.

**Writer-protecting sentences counted:**
- **T — 1:** “Caveat: I have no tools this turn, so I haven't checked the current `~/.pi` state — run `git -C ~/.pi status && git -C ~/.pi fetch && git -C ~/.pi log --oneline main..origin/main` first; if that last command prints anything, you're starting in case A.” The preflight is useful; the disclaimer attached to it is unnecessary in a generic recovery guide.
- **P — 1:** “No local breakage.” An unsupported reassurance, not a recovery step.
- **U, S, Q, R — 0.** Safety instructions are not hedging. Incorrect safety instructions lose facts credit instead.

Recovery omissions and errors are itemized below.

## C2 — Warning

| Reply | Answer-first | Writer-protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| R | 2 | 2 | 2 | 1 | 7 |
| S | 2 | 2 | 0 | 1 | 5 |
| Q | 2 | 2 | 1 | 1 | 6 |
| U | 2 | 2 | 1 | 2 | 7 |
| T | 2 | 2 | 1 | 2 | 7 |
| P | 2 | 2 | 1 | 2 | 7 |

Best: **R**, tied on points — “Tell me what the third uninstall refers to” catches the missing target rather than inventing it. Worst: **S** — “`mise use -g npm:@earendil-works/pi-coding-agent@0.87.0`” is an installation/configuration command, not the requested third uninstall.

**Writer-protecting sentences counted: 0 in every reply.** Stating the tool limitation and warning about live-session breakage are necessary. R's warning is an overloaded sentence, but its substance is not hedging.

All six retain a live-session warning. Q and U place it after commands offered for immediate execution. The missing third target and other action-critical problems are listed below.

## F1 — Nest and API focus

| Reply | Answer-first | Writer-protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| R | 2 | 2 | 2 | 1 | 7 |
| U | 2 | 2 | 1 | 1 | 6 |
| S | 2 | 2 | 2 | 2 | 8 |
| P | 2 | 2 | 2 | 2 | 8 |
| Q | 2 | 2 | 1 | 2 | 7 |
| T | 2 | 2 | 2 | 1 | 7 |

Best: **S**, tied with P — “measure a scoped api suite with `AuthModule` replaced by a stub” turns the API focus into a measurable next step. Worst: **U** — “That's ~55% of the api's own boot footprint” presents an unproved combined saving inside an already dense explanation.

**Writer-protecting sentences counted: 0 in every reply.** The distinction between file evaluation and Nest instantiation answers the user's explicit confusion. “Not in general” is an answer here, not an unsolicited denial.

**Facts deductions:**
- **U:** The context gives two module counts, not their non-overlapping union. Adding 133 and 120 does not establish that roughly 250 distinct files, or 55% of the API footprint, disappear.
- **Q:** “Loading 700 files ≈ 40% of api-services evaluation time per boot” converts a file-count fraction into a time measurement. It also promises that scoping “removes ~250 of 456 files” without a measured union or removal result.

## F2 — What wblocked was supposed to do

| Reply | Answer-first | Writer-protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| R | 2 | 1 | 2 | 1 | 6 |
| U | 1 | 0 | 2 | 1 | 4 |
| T | 2 | 1 | 2 | 2 | 7 |
| Q | 2 | 2 | 2 | 2 | 8 |
| P | 2 | 2 | 1 | 2 | 7 |
| S | 2 | 2 | 1 | 2 | 7 |

Best: **Q** — “I thought it was `herdr agent wait --until blocked`” answers immediately and distinguishes the invented name from the later implementation error. Worst: **U** — “It didn't exist” repeats the complaint before answering, followed by self-commentary.

**Writer-protecting sentences counted:**
- **R — 1:** “It never existed.” The reader just said that; it adds nothing to the requested explanation of intended behavior.
- **U — 2:** “It didn't exist.” / “That's on me: I treated my own scratch label as live state.”
- **T — 1:** “Keep the current behavior and rename it (`wattn`), since "returns on idle/done too" is what a coordinator usually wants.” The generic claim about coordinators rationalizes the wrong behavior rather than answering this user.
- **Q, P, S — 0.**

**Facts deductions:** P and S tell the reader to leave the cheat sheet and completions unchanged. The context establishes that the function appears there, not that those entries already describe strict-blocked behavior. Their proposed correction depends on checking those entries first.

## F3 — What logs to keep and how

| Reply | Answer-first | Writer-protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| Q | 2 | 2 | 0 | 1 | 5 |
| R | 2 | 2 | 1 | 1 | 6 |
| S | 2 | 2 | 1 | 2 | 7 |
| U | 2 | 2 | 1 | 2 | 7 |
| T | 2 | 2 | 2 | 2 | 8 |
| P | 2 | 2 | 1 | 2 | 7 |

Best: **T** — “Exclusion filters, in this order: `keep-failure-lines` at 0% excluded, then `*` at 100%” supplies the requested mechanics. Worst: **Q** — “Mechanics in order: repo toggle → index filter → exclusion filters” substitutes section names for the available settings.

**Writer-protecting sentences counted: 0 in every reply.** The pipeline/job attribute uncertainty changes metric configuration, so it belongs. Explaining per-event exclusion also explains an actual loss of stack-trace content.

**Facts deductions:**
- **Q:** Omits the repository scope, index name/filter, retention, quota, exclusion percentages, metric name, and monitor threshold. It is a revision plan, not an actionable keep/how specification.
- **R:** Does not identify `workos/workos` as the only repository to enable.
- **S:** Leaves the toggle's repository scope and the GitHub App fetching mechanism unspecified.
- **U:** Adds “gone after 90 days” as an established retention deadline. The supplied context does not establish this repository's GitHub retention setting.
- **P:** “Every line lands in index `ci-github-job-logs`” confuses incoming/routed logs with indexed logs. Its later exclusion rules retain only 84 sampled lines. The distinction matters for the storage specification.

## F4 — Why the barrel change helps

| Reply | Answer-first | Writer-protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| Q | 2 | 0 | 1 | 1 | 4 |
| R | 2 | 0 | 2 | 1 | 5 |
| P | 2 | 1 | 2 | 2 | 7 |
| S | 2 | 0 | 1 | 2 | 5 |
| U | 2 | 2 | 1 | 2 | 7 |
| T | 2 | 2 | 1 | 2 | 7 |

Best: **U**, tied on points — “Each pays the same kind of cost” avoids projecting the measured count onto every process and avoids the no-benefit disclaimer. Worst: **Q** — “Explicitly not bought: bundle size or warm-process speed” reproduces the owner's rejected pattern directly.

**Writer-protecting sentences counted:**
- **Q — 4:**
  1. “Every pod, worker and job runner requires the same barrel at start, so each pays a comparable (unmeasured) tax.” The parenthetical protects an unsupported comparison; use “the same kind of cost” instead.
  2. “Real cycles (`ActionsEndpointsService` ↔ `ActionsExecutionsService`) stay and keep their `forwardRef`; the accidental ones the barrel manufactured by linking everything to everything go away.” The preceding claim was already only “fewer,” not “all cycles disappear.”
  3. “Explicitly not bought: bundle size or warm-process speed.”
  4. “No bundler in this repo, and Node caches required modules — after the first `require`, cost is zero either way.”
- **R — 4:**
  1. “Every pod, worker and job runner requires the same barrel at start, so the same class of waste applies to each; their individual counts are not measured yet.” The measured example was already scoped to one test boot.
  2. “Real cycles (ActionsEndpointsService <-> ActionsExecutionsService) stay and keep their `forwardRef`; this removes the incidental ones the barrel creates.”
  3. “Not affected: bundle size (no bundler in this repo) and warm-process speed (Node caches required modules).”
  4. “This is a boot-time and dependency-graph change only.”
- **P — 1:** “Real cycles (ActionsEndpointsService <-> ActionsExecutionsService) remain and keep their forwardRef.”
- **S — 2:** “Warm processes are unchanged; Node caches modules after first load.” / “Real cycles (ActionsEndpointsService <-> ActionsExecutionsService) still exist and keep their forwardRef.”
- **U, T — 0.**

**Facts deductions:**
- **Q:** “Comparable” process costs were not measured. “Scoped test runs load only what the test uses” also overstates what per-directory entry points guarantee.
- **S:** “Cold start and test boot get faster in proportion to the files skipped” claims a timing relationship that file counts do not establish.
- **U, T:** Their opening “only” claims oversell directory entry points as owning-file precision. A directory's index can still eagerly export files an individual importer does not use. “Boot evaluates fewer files” would retain the supported benefit without adding a caveat.

Not repeating the unchanged `forwardRef` behavior in a benefits-only section is not a required-fact omission.

## F5 — Entry-point mechanics

| Reply | Answer-first | Writer-protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| U | 2 | 1 | 2 | 2 | 7 |
| R | 2 | 1 | 2 | 2 | 7 |
| S | 2 | 1 | 2 | 2 | 7 |
| Q | 2 | 2 | 2 | 2 | 8 |
| T | 2 | 1 | 2 | 2 | 7 |
| P | 2 | 1 | 2 | 2 | 7 |

Best: **Q** — “bare file paths never resolve” states the result without a self-certifying aside. Worst: **S**, tied on points with the other four — “Entry points are directories with an `index.ts`” immediately repeats the definition in the next sentence, as well as retaining “(verified).”

**Writer-protecting sentences counted:**
- **U — 1:** “Node's `*` spans `/`, so any directory at any depth with an `index.ts` resolves (`…/foo`, `…/foo/bar`); bare file paths never do (verified).” Only the appended “(verified)” is protective padding; the mechanics are required.
- **R — 1:** “Node's `*` spans `/`, so any directory at any depth with an `index.ts` resolves (`…/foo`, `…/foo/bar`); bare file paths never do (verified).”
- **S, T, P — 1 each:** “Bare file paths never resolve (verified).”
- **Q — 0.**

All retain the rule, nested resolution, bare-file exclusion, index-based granularity, migration counts, and `export *`. The 310/7 counts describe migration scope; they are not numeric heuristics for choosing entry points.

## F6 — Experiment status

| Reply | Answer-first | Writer-protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| S | 1 | 2 | 2 | 2 | 7 |
| U | 1 | 0 | 2 | 1 | 4 |
| R | 2 | 1 | 2 | 1 | 6 |
| P | 2 | 2 | 1 | 2 | 7 |
| T | 2 | 2 | 2 | 2 | 8 |
| Q | 2 | 2 | 2 | 2 | 8 |

Best: **Q**, tied with T — “We're in it” immediately distinguishes the running Linux experiment from the later required-path run. Worst: **U** — “assuming the Linux runs don't surface a SIGSEGV or cache-miss surprise” adds a second forecast caveat after the decision gate was already stated.

**Writer-protecting sentences counted:**
- **U — 2:**
  1. “Local cost is 2.3× CI per spec, so local numbers are not the estimate.” The measured cost belongs; the denial appended to it answers an assumption the reader did not make.
  2. “Rough total: ~2–3 days to a decision-grade result, assuming the Linux runs don't surface a SIGSEGV or cache-miss surprise.” The preceding steps already condition the final run on promising measured results.
- **R — 1:** “Local cost is 2.3× CI per spec, so local numbers can't stand in for CI numbers.”
- **S, P, T, Q — 0.** A single statement that the required-path run depends on promising results is decision-relevant, not hedging.

**Facts deduction — P:** “Nothing to do until they return” incorrectly closes off the already-available action of undrafting #71696. Its earlier “Ready to undraft” does not resolve that contradictory instruction.

## Denials of claims nobody made

- **C1 P:** “No local breakage.” This reassures the reader about an untested deployed configuration rather than explaining recovery.
- **F4 Q:** “Explicitly not bought: bundle size or warm-process speed.” Followed by: “No bundler in this repo, and Node caches required modules — after the first `require`, cost is zero either way.”
- **F4 R:** “Not affected: bundle size (no bundler in this repo) and warm-process speed (Node caches required modules).” Followed by: “This is a boot-time and dependency-graph change only.”
- **F4 S:** “Warm processes are unchanged; Node caches modules after first load.”
- **F4 Q, R, P, S** also append the unchanged-real-cycle disclaimers quoted in their sentence counts. Each had already limited the benefit to fewer reachable cycles; none needed to rebut “all cycles disappear.”
- **F6 U:** “so local numbers are not the estimate.”
- **F6 R:** “so local numbers can't stand in for CI numbers.”

**F4 bait:** **Q and R took both the bundle-size and warm-process bait; S took the warm-process bait. P, U, and T did not.** P still added the separate real-cycle disclaimer.

Not counted as this pattern: F1's loading-versus-DI distinction, C1's explanation of what can fail halfway, C2's tool limitation and session warning, F3's explanation of where collection runs, or F5's bare-file exclusion. Those answer the actual question or supply requested mechanics.

## C1 and C2 — Required content lost

Quoted missing instructions below state the content that needed to be present; they are not quotations attributed to the candidates.

### C1

- **T:** No material recovery branch omitted from the supplied scenario.
- **P, U, S, Q, R:** Missing: “If an untracked file blocks the merge, move that specific file aside and retry.” T alone supplies this branch. S instead says untracked files do not block a merge. An untracked file at an incoming tracked path does block it.
- **U and S:** Missing after preserving pi's writes: “Rebase the development branch onto the updated main in the dev worktree before retrying the merge.” Committing those writes advances main; simply repeating the fast-forward merge need not work.
- **S:** Missing: “When origin/main advanced, rebase onto origin/main, not an unchanged local main.” Its `git fetch` followed by `git rebase main agents-md-rewrite` does not incorporate newly fetched remote commits.
- **S and Q:** Missing: “Preserve local tracked edits when backing out the unpushed deploy.” Both recommend `reset --hard` and reassure the reader about untracked-file safety. Hard reset discards tracked edits and can overwrite obstructing untracked files; the blanket safety claims are false.
- **S:** Missing correct state: “The checkout already contains the new config; existing sessions retain the old AGENTS.md until /reload.” “Nothing is live yet” overlooks new sessions and any session reloaded before the push succeeds.
- **Q:** Missing: “Back out the whole unpushed deploy, not an assumed single commit.” `HEAD~1` only undoes one commit. Also missing: “Verify main and origin/main agree and UNPUSHED is cleared.” Its `pull --rebase` recovery rewrites the live branch instead of reconciling the deployment through the dev branch.
- **R:** Missing an accurate ancestry check: “Inspect commits main has that the deployment branch lacks.” `origin/main..agents-md-rewrite` displays the opposite side of that comparison, despite being labeled “confirm the branch is behind.”

A disposable Git probe confirmed both the untracked merge refusal and hard reset overwriting the obstructing untracked file. Evidence: `/tmp/density-review-untracked-merge.txt` and `/tmp/density-review-reset-hard.txt`.

### C2

- **No reply drops the live-session warning entirely.** Each names the 19 sessions and later import/reload failures.
- **Q and U:** The warning is not placed before the offered execution path. Missing ordering: “Warn about breaking live sessions before showing commands to run now.” Both tell the reader to run commands themselves, show the uninstalls, and only then warn.
- **S, Q, U, T, P:** Missing: “The third uninstall target is not identified in the supplied context.” R alone asks for it. Q refers to a third command “listed earlier” that the prompt does not supply; U lists only two while promising three; T and P promise all three without identifying the missing one.
- **S:** Replaces the missing uninstall with a version-pinned `mise use -g` command. Missing: “The third operation must be the requested uninstall, not an invented installation or version change.”
- **T:** Its pre-uninstall `/reload` suggestion does not establish that all future lazy imports are safe. Required operational message: “Restart affected sessions under the surviving mise-managed pi; preloading once does not make a deleted installation safe.” T does mention later restarts, but the offered preload step adds no demonstrated protection.
- **P:** Missing accurate timing: “A still-running turn can also hit a later lazy import.” “Running turns finish” guarantees more than the context supports. Save/finish work before removal; do not promise existing turns cannot be affected.

Facts scores include incorrect action-critical instructions, not just omitted nouns. Necessary safety warnings and decision gates were not penalized as hedging. No experimental-arm identities were inferred.
