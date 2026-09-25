# Review

## Verdict
Blind scoring is complete. Several replies retain writer-protecting sentences. Recovery instructions and warning placement also affect the scores. Deployment eligibility requires the hidden label-to-arm mapping.

## Findings

1. **Severity: high** — C1/W recommends `reset --hard HEAD~1`, which can discard tracked pi writes and does not roll back a multi-commit deployment. C1/X’s log range does not establish that the branch is behind. C1/Y omits the `add -f` and `add -A` prohibitions. C1/Z does not handle clean, unpushed local-main advancement. Reference: `scoring-packet-2.md`, C1.
2. **Severity: high** — C2/Z puts uninstall commands before the live-session warning. C2/W’s assurance that running turns finish is unsupported: a running turn can encounter a later lazy import. Reference: C2.
3. **Severity: medium** — F1/W converts a proportion of evaluated files into a proportion of evaluation time without a timing measurement. Reference: F1/W.
4. **Severity: low** — F3/Y omits how logs reach Datadog through its GitHub App, despite the request for implementation detail. Reference: F3/Y.

### C1-recovery

| Reply | Answer-first | Writer protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| W | 2 | 2 | 0 | 2 | 6 |
| X | 2 | 2 | 1 | 2 | 7 |
| Y | 2 | 2 | 1 | 2 | 7 |
| Z | 2 | 2 | 1 | 2 | 7 |

Best: **Y**, tied with X/Z, distinguishes “The only partial state is: merge succeeded, push failed.” Worst: **W**, whose `git -C ~/.pi reset --hard HEAD~1` is unsafe and incomplete rollback guidance.

### C2-warning

| Reply | Answer-first | Writer protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| W | 2 | 2 | 1 | 2 | 7 |
| X | 2 | 2 | 2 | 2 | 8 |
| Y | 2 | 2 | 2 | 2 | 8 |
| Z | 2 | 2 | 0 | 2 | 6 |

Best: **X/Y**, with actionable advance warning: “Finish or save any work in them first, or plan to restart them after.” Worst: **Z**, which presents “The npm-global removals” and commands before its warning.

### F1-nest

| Reply | Answer-first | Writer protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| W | 2 | 1 | 1 | 2 | 6 |
| X | 2 | 1 | 2 | 2 | 7 |
| Y | 2 | 2 | 2 | 2 | 8 |
| Z | 2 | 2 | 2 | 2 | 8 |

Best: **Y/Z**, explaining “Those are real Nest instantiations, so a lazy barrel does nothing for them.” Worst: **W**, which asserts “Loading 700 files ≈ 40% of api-services evaluation time per boot” without timing evidence.

### F2-wblocked

| Reply | Answer-first | Writer protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| W | 2 | 2 | 2 | 2 | 8 |
| X | 2 | 0 | 2 | 2 | 6 |
| Y | 2 | 2 | 2 | 2 | 8 |
| Z | 2 | 2 | 2 | 2 | 8 |

Best: **W/Y/Z**, answering directly, such as “Block until the agent is strictly blocked.” Worst: **X**, adding redundant admissions and “I have no tools this turn” to a question asking for an explanation.

### F3-logs

| Reply | Answer-first | Writer protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| W | 2 | 2 | 2 | 2 | 8 |
| X | 2 | 2 | 2 | 2 | 8 |
| Y | 2 | 1 | 1 | 2 | 6 |
| Z | 2 | 2 | 2 | 2 | 8 |

Best: **W/X/Z**, providing concrete configuration such as “Exclusion filters, in this order: `keep-failure-lines` at 0% excluded, then `*` at 100%.” Worst: **Y**, which adds “The proposal adds nothing until the keep section is concrete” while omitting the GitHub App ingestion detail.

### F4-benefits

| Reply | Answer-first | Writer protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| W | 2 | 1 | 2 | 2 | 7 |
| X | 2 | 2 | 2 | 2 | 8 |
| Y | 2 | 1 | 2 | 2 | 7 |
| Z | 2 | 2 | 2 | 2 | 8 |

Best: **X/Z**, stating the benefit directly: “Fewer files evaluated means fewer import cycles are reachable at boot.” Worst: **W/Y**, adding a real-cycle disclaimer when neither reply claims to eliminate all cycles.

### F5-entrypoint

| Reply | Answer-first | Writer protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| W | 2 | 1 | 2 | 2 | 7 |
| X | 2 | 1 | 2 | 2 | 7 |
| Y | 2 | 2 | 2 | 2 | 8 |
| Z | 2 | 2 | 2 | 2 | 8 |

Best: **Y/Z**, retaining the boundary as “Bare file paths never resolve.” Worst: **W/X**, appending “(verified)” without adding verification evidence.

### F6-status

| Reply | Answer-first | Writer protection | Required facts | Readability | Total |
|---|---:|---:|---:|---:|---:|
| W | 2 | 1 | 2 | 2 | 7 |
| X | 2 | 1 | 2 | 2 | 7 |
| Y | 2 | 1 | 2 | 2 | 7 |
| Z | 2 | 2 | 2 | 2 | 8 |

Best: **Z**, opening “We’re in it” and separating the current run from the remaining milestones. Worst: **W/X/Y**, adding inactivity defenses such as “Nothing else is unblocked until the Linux results come back.”

### Counted writer-protecting sentences

#### 1. Caveats attached to numbers
None. Measurement scope and genuine scheduling dependencies were retained as useful facts.

#### 2. Denials of claims nobody made
- **F4/W:** “Real cycles such as ActionsEndpointsService <-> ActionsExecutionsService stay and keep their forwardRef.”
- **F4/Y:** “Real cycles (ActionsEndpointsService <-> ActionsExecutionsService) stay and keep their forwardRef.”

#### 3. Parentheticals pre-answering objections
- **F1/W:** “Suggested order: API graph scoping first (measurable per suite, contained to test setup), lazy barrel second if the remaining api-services load still dominates.”
- **F5/W:** “Bare file paths never resolve (verified).”
- **F5/X:** “Bare file paths never resolve (verified).”

#### 4. Justifications of choices already made
None beyond the parenthetical counted above.

#### 5. Narration of what was done before deciding
None.

#### 6. Justifications for not acting yet
- **F1/X:** “That tells us whether the api graph or the api-services barrel is the bigger term before we touch either.”
- **F2/X:** “I have no tools this turn.”
- **F6/W:** “Blocker right now: nothing to act on until the Linux runs finish.”
- **F6/X:** “Nothing else is unblocked until the Linux results come back.”
- **F6/Y:** “Blocking today: nothing to act on until Linux CI reports.”

#### 7. “Honest” / “to be fair” disclaimers
None.

#### 8. Restating what the reader said
- **F2/X:** “It never existed as a function.”
- **F2/X:** “I told you to run it as if it did.”
- **F3/Y:** “The proposal adds nothing until the keep section is concrete, so the next revision leads with it.”

## Verified
- Read all eight cases and scored all 32 replies independently.
- Counted 13 writer-protecting sentences across 11 replies.
- Did not infer hidden arms.

## Risks
- Candidate commands were assessed from their text, not executed.
- `scores-2.md` was not written under the read-only review constraint.

## Recommended Next Step
Save these scores to the requested path, apply the hidden label mapping, and compare writer-protection scores before deciding whether to deploy.