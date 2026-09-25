# Packet 3 scores

Columns: Answer-first / Writer-protecting / Facts / Readability / Total.

## C1-recovery

| Reply | AF | WP | Facts | Read | Total |
|---|---|---|---|---|---|
| K | 2 | 2 | 1 | 2 | 7 |
| M | 2 | 2 | 2 | 2 | 8 |
| J | 2 | 1 | 2 | 1 | 6 |
| L | 2 | 1 | 2 | 1 | 6 |

Best M — "It can't fail halfway." then numbered steps per failure, `reset --keep origin/main` for the diverged push. Worst L — six sections and a table for two failure modes; "This incorporates both local and remote `main` without rewriting either history."

Notes: K facts 1 for `git -C ~/.pi reset --hard HEAD~1` — assumes the branch is one commit; a multi-commit branch leaves the live config half-reverted. M's `git log --oneline origin/main..agents-md-rewrite — confirm the branch is behind` has the range reversed; diagnostic only, recovery path still correct. M's `git revert <merge-tip>` has the same one-commit assumption as K but is reviewable before deploy.

## C2-warning

| Reply | AF | WP | Facts | Read | Total |
|---|---|---|---|---|---|
| J | 2 | 2 | 2 | 1 | 7 |
| M | 2 | 2 | 2 | 2 | 8 |
| K | 2 | 2 | 2 | 2 | 8 |
| L | 2 | 2 | 2 | 2 | 8 |

Best M — "Running turns finish; only later imports break." plus the recovery line; warning before any command, how to re-trigger, nothing extra. Worst J — "`/reload` each live pane before the uninstall, then restart any pane that needs a reload later." — purpose unstated, both options end in restarts, so the choice is unclear.

## F1-nest

| Reply | AF | WP | Facts | Read | Total |
|---|---|---|---|---|---|
| K | 2 | 2 | 2 | 2 | 8 |
| M | 2 | 2 | 2 | 1 | 7 |
| J | 2 | 2 | 2 | 2 | 8 |
| L | 2 | 1 | 2 | 2 | 7 |

Best K — "So the API-side fix is graph scoping, not import mechanics" — answers all three questions and names a concrete API-side change with its size. Worst M — the eight-sentence paragraph from "You're right that Nest resolves dependencies at startup." to "regardless of module scoping." re-derives every number already on the table.

## F2-wblocked

| Reply | AF | WP | Facts | Read | Total |
|---|---|---|---|---|---|
| M | 2 | 2 | 2 | 2 | 8 |
| J | 2 | 2 | 2 | 2 | 8 |
| K | 2 | 2 | 2 | 2 | 8 |
| L | 2 | 2 | 2 | 2 | 8 |

Best J — "Fix: add `--until blocked` inside the function body and leave the cheat sheet and completion entries as they are." — answer, gap, one-line fix, three short paragraphs. Worst M — "That was the whole idea: a one-word alias for 'wake me when it's stuck.'" restates the answer just given, then an options menu for a one-line fix.

## F3-logs

| Reply | AF | WP | Facts | Read | Total |
|---|---|---|---|---|---|
| J | 2 | 2 | 2 | 2 | 8 |
| M | 2 | 2 | 2 | 2 | 8 |
| L | 2 | 1 | 1 | 2 | 6 |
| K | 2 | 0 | 1 | 2 | 5 |

Best J — "Yes — every job log is already in GitHub Actions." then a concrete what/how plan for the doc and a closing question on the pattern table. Worst K — "That retains only events matching the keep-filter, not whole failed jobs." and it re-describes the doc the user just rejected.

Notes: K and L facts 1 — neither says how the "why" gets cut or what detail is added; both restate the doc's existing content, so the user cannot approve a revision. M's "Every line lands in index `ci-github-job-logs`" is loose (excluded events are not stored) but the exclusion section corrects it.

## F4-benefits

| Reply | AF | WP | Facts | Read | Total |
|---|---|---|---|---|---|
| K | 2 | 2 | 2 | 2 | 8 |
| L | 2 | 2 | 2 | 2 | 8 |
| M | 2 | 1 | 1 | 2 | 6 |
| J | 2 | 1 | 2 | 2 | 7 |

Best L — "The saving applies to every pod, worker and job runner. Each requires the same barrel at start." — three bullets, no caveat. Worst M — "Real cycles such as `ActionsEndpointsService` ↔ `ActionsExecutionsService` still need `forwardRef`." is a caveat inside a Why bullet, and the pods/workers/job-runners scope is missing.

Notes: J's "Unrelated services no longer enter the dependency graph" reads as Nest's DI graph, which the barrel does not affect; kept at 2 because the import-cycle framing makes the module graph the likelier reading.

## F5-entrypoint

| Reply | AF | WP | Facts | Read | Total |
|---|---|---|---|---|---|
| L | 2 | 2 | 2 | 2 | 8 |
| J | 2 | 2 | 2 | 2 | 8 |
| K | 2 | 2 | 2 | 2 | 8 |
| M | 2 | 2 | 2 | 2 | 8 |

Best J — "**Entry points.** A directory is an entry point iff it has an `index.ts`. Put one where a consumer of anything inside would want everything inside. `export *` is fine in it." — labelled bullets, the `export *` fact sits with the rule it governs. Worst M — "Bare file paths never resolve through this mapping (verified)." — the added qualifier narrows a verified claim the brief states without qualification.

## F6-status

| Reply | AF | WP | Facts | Read | Total |
|---|---|---|---|---|---|
| L | 2 | 2 | 2 | 2 | 8 |
| J | 2 | 2 | 2 | 2 | 8 |
| K | 2 | 2 | 2 | 2 | 8 |
| M | 2 | 2 | 2 | 2 | 8 |

Best L — "So the full experiment is ~2–3 working days out, gated on today's Linux results." — one number for the distance, then state, then the one open action. Worst M — "After that, we need half a day for the PR-speed estimate." — the lead names a vague deliverable; the concrete PR p50 appears only in step 2, and no open action for the user.

## Counted writer-protecting sentences

**C1-recovery**
- J: "You do not need another merge."
- L: "This incorporates both local and remote `main` without rewriting either history."

**C2-warning** — none.

**F1-nest**
- L: "That targets the API startup cost directly."

**F2-wblocked** — none.

**F3-logs**
- K: "The rewritten proposal at `/tmp/proposal-gh-job-logs-to-datadog.md` shows every retained line for three real jobs:"
- K: "That retains only events matching the keep-filter, not whole failed jobs."
- L: "The [rewritten proposal](/tmp/proposal-gh-job-logs-to-datadog.md) shows the **exact retained lines** for three jobs:"

**F4-benefits**
- M: "Real cycles such as `ActionsEndpointsService` ↔ `ActionsExecutionsService` still need `forwardRef`."
- J: "The `ActionsEndpointsService` ↔ `ActionsExecutionsService` cycle still requires `forwardRef`."

**F5-entrypoint** — none.

**F6-status** — none.
