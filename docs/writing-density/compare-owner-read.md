# F2-wblocked

## Prompt

[Context: you are mid-session in a pi coding agent. Earlier you told the user to run a fish function `wblocked` that did not exist; you had invented the name in your own notes as shorthand for `herdr agent wait --until blocked`. Under time pressure you then built it, but wired it to herdr's default attention states (idle, done, or blocked) rather than strictly blocked. It is now in the cheat sheet and completions. You have no tools this turn; reply to the user.]

OK here is the deal. YOU hallicunated wblocked in the first place. What did you think it was going to do?

## fable-5.1

I thought it would run `herdr agent wait --until blocked` — block until the named agent stops because it needs input, then return. That was the whole idea: a one-word alias for "wake me when it's stuck."

What's on disk now is `herdr agent wait` with the default attention set, so it returns on idle, done, or blocked. That is a different tool. A `wblocked foo` that returns when `foo` finishes is a lie in the name.

Options, your call:

1. Fix it: change the function body to `herdr agent wait --until blocked $argv`. Cheat sheet and completions stay as they are, since they describe the intended behaviour.
2. Delete it: remove the function, its completion file, and the `~/.config/cheat/ws.md` entry.

I recommend 1. It is a one-line edit and the name then matches what it does.

## Astra

I meant `wblocked` to run `herdr agent wait --until blocked`: wait until the agent enters **blocked**.

I implemented the wrong condition, so it returns on **idle, done, or blocked** instead of waiting strictly for **blocked**.


---

# F3-logs

## Prompt

[Context: you are mid-session in a pi coding agent. You just rewrote a proposal at /tmp/proposal-gh-job-logs-to-datadog.md. Facts about the rewrite: you ran the proposed keep-filter over 34 real GitHub job logs — 214,741 lines in, 84 kept; the doc shows the exact kept lines for three real jobs (Lint schema migrations 1,154 → 3; Danger 969 → 8; a 17,951-line test shard → 5). Datadog config in the doc: toggle on workos/workos only (Datadog fetches via its own GitHub App); dedicated index ci-github-job-logs with filter source:github datadog.product:cipipeline, 3-day retention, 1 GB/day quota; two exclusion filters in order (keep-failure-lines at 0% excluded, then * at 100%); a logs-to-metric ci.github.rate_limit_hits by pipeline/job generated from excluded logs too; a monitor at >20 hits/15 min. Dropped on purpose: ##[group]Run step headers, "level":"ERROR" PgDog lines (benign), Jest stack traces (exclusion is per event). Unknown until logs flow: whether forwarded logs carry @ci.pipeline.name/@ci.job.name. You have no tools this turn; reply to the user.]

Proposal isn't good enough. We can already look at the logs, can't we? I want a little less why and more detail on what logs we will keep and how

## fable-5.1

Yes — every job log is already in GitHub Actions. Datadog adds two things: search across all jobs at once, and the `ci.github.rate_limit_hits` metric with its monitor.

I'll cut the "why" to those two lines and expand the rest into:

**What we keep**
- Per-line: the keep-filter's match list, one pattern per row with the line it catches.
- Result on real logs: 34 jobs, 214,741 lines in, 84 kept.
- Worked examples, full kept output for each: Lint schema migrations 1,154 → 3; Danger 969 → 8; 17,951-line test shard → 5.
- Dropped on purpose: `##[group]Run` step headers, `"level":"ERROR"` PgDog lines (benign), Jest stack traces (exclusion is per event, so a trace's continuation lines go).

**How**
1. Enable the Datadog GitHub integration on `workos/workos`. Datadog pulls logs through its own GitHub App; nothing runs in our workflows.
2. Index `ci-github-job-logs`, filter `source:github datadog.product:cipipeline`, 3-day retention, 1 GB/day quota.
3. Exclusion filters, in this order: `keep-failure-lines` at 0% excluded, then `*` at 100%.
4. Logs-to-metric `ci.github.rate_limit_hits` by pipeline/job, generated from excluded logs too, so rate-limit lines count without being stored.
5. Monitor: >20 hits / 15 min.

Prerequisite to verify once logs flow: forwarded logs carry `@ci.pipeline.name` and `@ci.job.name`. If not, the metric tags in step 4 change.

Want the keep-filter patterns as a table or as the raw filter expression?

## Astra

Yes. I tested the keep-filter against **34 real GitHub job logs: 214,741 lines in, 84 kept**.

The [rewritten proposal](/tmp/proposal-gh-job-logs-to-datadog.md) shows the **exact retained lines** for three jobs:
- Lint schema migrations: **1,154 → 3**
- Danger: **969 → 8**
- Test shard: **17,951 → 5**

It drops `##[group]Run` step headers, benign PgDog `"level":"ERROR"` lines, and Jest stack traces. Exclusion works per event, so keeping an error line does not retain its surrounding stack trace.

**How retention works:**
1. Enable forwarding for `workos/workos` only. Datadog fetches through its own GitHub App.
2. Route events matching `source:github datadog.product:cipipeline` into the dedicated `ci-github-job-logs` index.
3. Set **3-day retention** and a **1 GB/day quota**.
4. Apply exclusion filters in this order:
   - `keep-failure-lines`: **0% excluded**
   - `*`: **100% excluded**

**How rate-limit detection works:**
- Generate `ci.github.rate_limit_hits` from matching events, including logs excluded from the index.
- Group by pipeline and job.
- Alert at **more than 20 hits in 15 minutes**.

Once logs flow, verify that events carry `@ci.pipeline.name` and `@ci.job.name` before relying on that grouping.


---

# C1-recovery

## Prompt

[Context: you are mid-session in a pi coding agent. ~/.pi is a locked sparse git worktree of the pawprint repo on main; the live pi config is the checkout. The user is about to deploy a branch with `git -C ~/.pi merge --ff-only agents-md-rewrite && git -C ~/.pi push`. Relevant facts: --ff-only refuses if main has moved (no partial state); a merge that succeeds locally but fails to push leaves ~/.pi ahead of origin (validate.sh reports UNPUSHED); running pi sessions keep the old AGENTS.md until /reload; `git -C ~/.pi status` shows anything pi wrote; never use add -f, add -A, clean, or stash -u in ~/.pi because auth.json and sessions/ are untracked there. You have no tools this turn; reply to the user.]

Before I run the merge: what exactly do I do if it fails halfway? Give me the full recovery steps, I want all of them.

## fable-5.1

It can't fail halfway. `--ff-only` either moves `main` to the branch tip in one step or refuses and changes nothing. There are two places it can stop.

**1. The merge refuses ("Not possible to fast-forward")**
`main` in `~/.pi` has moved since you branched.
```
git -C ~/.pi status              # see what pi wrote; keep it with add -p + commit + push
git -C ~/.pi log --oneline -5    # see the new commits on main
```
Then in the dev worktree:
```
git rebase main agents-md-rewrite
```
Re-run tests, then retry the merge. `~/.pi` is untouched until it succeeds.

**2. The merge succeeds, the push fails**
`~/.pi` is now ahead of origin; `validate.sh` reports UNPUSHED. The config is already live for new sessions.
```
git -C ~/.pi fetch
git -C ~/.pi status              # "ahead N" = origin didn't move; just retry
git -C ~/.pi push
```
If `status` shows "diverged", someone pushed to `main` on origin:
```
git -C ~/.pi pull --rebase       # only if `git -C ~/.pi status` shows no unstaged changes
git -C ~/.pi push
```
If there are unstaged changes, commit them first with `add -p` on the specific `agent/<file>`.

**Rollback if the new AGENTS.md is bad**
```
git -C ~/.pi reset --hard HEAD~1    # before push
git -C ~/.pi revert HEAD && git -C ~/.pi push   # after push
```
`reset --hard` and `revert` only touch tracked files. auth.json and sessions/ are safe.

**Never in `~/.pi`:** `add -f`, `add -A`, `clean`, `stash -u`, branch switches.

**After success:** running pi sessions keep the old AGENTS.md until you `/reload` each one.

## Astra

**If the fast-forward merge is refused, there is nothing to undo. If the merge succeeds but the push fails, `~/.pi` already contains the new config. Recover the push without resetting the live checkout.**

## 1. Before running the deployment

```sh
git -C ~/.pi status
git -C ~/.pi rev-parse HEAD
```

Save the commit hash as your pre-deployment reference.

If status shows changes, handle them before merging, as described below.

## 2. If the merge fails

The `&&` means the push did not run. A refused `--ff-only` does not leave a conflicted merge to abort.

Inspect the reason and current state:

```sh
git -C ~/.pi status
git -C ~/.pi diff
git -C ~/.pi diff --cached
```

### If local changes blocked it

Keep intentional changes that pi wrote.

For an existing tracked config file:

```sh
git -C ~/.pi add -p -- agent/<file>
git -C ~/.pi diff --cached
git -C ~/.pi commit -m "Preserve pi config changes"
```

Commit only after the staged diff contains exactly what you intend. For an intended new config file, use `git add -- agent/<exact-file>` instead.

Leave unrelated untracked files alone. Never use `add -f`, `add -A`, `clean`, or `stash -u` in `~/.pi`. Do not stage `auth.json` or sessions.

If you do not recognize a change, stop and identify it before continuing.

Retry:

```sh
git -C ~/.pi merge --ff-only agents-md-rewrite &&
git -C ~/.pi push
```

If the preserved commit makes the branches diverge, use the next procedure.

### If `main` and the deployment branch diverged

Reconcile them **in the development worktree**, not in `~/.pi`.

Locate the worktree containing `agents-md-rewrite`:

```sh
git -C ~/.pi worktree list
```

In that worktree, confirm the branch and handle any unrelated work before proceeding:

```sh
git status
git branch --show-current
git fetch origin
git merge main
git merge origin/main
```

Run those commands one at a time. If either merge conflicts:

1. Resolve the files in the development worktree.
2. Stage only the resolved paths.
3. Run `git merge --continue`.
4. Finish any remaining merge above.

To abandon a conflicted merge, run `git merge --abort` **in that development worktree**.

Run the repository’s checks on the resulting branch. Then retry the deployment:

```sh
git -C ~/.pi merge --ff-only agents-md-rewrite &&
git -C ~/.pi push
```

## 3. If the merge succeeds but the push fails

The new files are already live on disk. `validate.sh` will report `UNPUSHED` while the local commits remain unpublished.

First refresh the remote state:

```sh
git -C ~/.pi fetch origin
git -C ~/.pi rev-list --left-right --count HEAD...origin/main
```

Interpret the two counts:

- **`0 0`**: local and remote match. The push may have reached the server before the connection failed.
- **Nonzero left, zero right**: local commits still need pushing.
- **Nonzero right**: the remote has commits missing locally.

### Network or authentication failure

Fix the reported connection or authentication problem. If `fetch` failed, rerun it before judging remote state.

If only local commits remain:

```sh
git -C ~/.pi push
```

You do not need another merge.

### Remote advanced or histories diverged

Use the development-worktree reconciliation procedure above. It incorporates both live `main` and refreshed `origin/main`.

Then rerun the fast-forward deployment. Do not force-push.

### Server policy rejection

Follow the rejection’s required approval or PR flow. Do not bypass it with a force-push.

Until publication succeeds, the deployment remains locally applied but unpublished. Do not reset the live checkout just to remove `UNPUSHED`.

## 4. Verify and reload

After the push succeeds:

```sh
git -C ~/.pi fetch origin
git -C ~/.pi rev-list --left-right --count HEAD...origin/main
git -C ~/.pi status
```

The counts must be **`0 0`**. Check that status has no unexpected tracked changes. Untracked credentials and sessions are not cleanup targets.

Run `validate.sh` on the final deployed state. Confirm that `UNPUSHED` is gone and the other checks pass.

Finally, run **`/reload` in every running pi session**. Confirm each reports `Reloaded`. Existing sessions retain the old `AGENTS.md` until reloaded.


---

