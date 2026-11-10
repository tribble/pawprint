# Managed code workflow

Any full Pi session uses fresh native herdr worktree → bounded main Coder → worker and independent fresh review for code changes of any size. Only trivial configuration may bypass this flow. Read-only work and non-code authoring use `configs/delegation.md`.

A responsive project Coordinator launches multiple independent delivery-owner mains concurrently in separate fresh native task trees. Each owner (`managed-coder`) supervises sequential native worker and fresh independent reviewer leaves. The owner triggers review, returns valid fixes, adjudicates findings and reports decisions/results. Neither main writes code. Herdr owns all processes/panes/lifecycle. Standalone `pi-intercom` owns messaging.

The launching parent owns scope, decisions, integrated acceptance, authorized publication and native lifecycle. Existing participants do not recursively wrap. Preserve legacy claims and unrelated work. A delegated session publishes/deploys only when assigned under owner authority. Already-authorized actions need no repeat approval.

## Native launch

Use Pi 1.5.0 or later and the immutable standalone pi-intercom pin in `settings.json`. Never load both Intercom extensions. Restart Pi to change SDK versions; `/reload` does not upgrade the host. Verify the actual leaf SDK, not merely CLI version. Use persistent native parent sessions. On launch/runtime failure preserve the exact error and native UUID/file/pane/command identities and stop. Do not implement inline or retry blindly.

1. Inspect source status and the repository's authorized base/path policy. Refresh relevant Git state and resolve the immutable base immediately before creation. Confirm the branch is unused and the target path absent, including dangling symlinks and registered worktrees. Herdr does not fetch. New pawprint task worktrees group under `/Users/pantera/work/pawprint-worktrees/<branch>`; the main checkout stays `/Users/pantera/work/pawprint`. Pawprint uses:

   ```sh
   herdr worktree create --cwd /Users/pantera/work/pawprint --branch <branch> \
     --base origin/main --path /Users/pantera/work/pawprint-worktrees/<branch> \
     --label <branch> --no-focus
   ```

2. Save the original receipt. Read `.result.worktree.path` and `.result.workspace.workspace_id`. Independently verify canonical path, branch, HEAD/base and Git common directory against the intended repository. Require a linked checkout whose Git admin directory differs from the common directory. Inspect for `pawprint-writer.json` and `pawprint-writer.lock`, including symlinks; any entry or unknown inspection blocks admission. Keep the exact native workspace ID, repo_key, path, base and persistent parent identity in the task plan. The plan indexes original receipts; it does not replace them.

3. Launch one bounded Coder through the public pane boundary:

   ```js
   launch_agent({
     name: "delivery-coder",
     role: "managed-coder",
     cwd: "/actual/verified/native/worktree/path",
     task: "Owner outcome:\n<verbatim ask>\n\n<bounded task, assigned absolute cwd, acceptance and authority>"
   });
   ```

   `managed-coder` requires the existing native linked cwd and rejects `base`. It does not create another worktree or persistent writer claim. Existing legacy Coder/Coordinator APIs and claims remain intact. The shared admission gate rejects concurrent/uncertain admission and observed same-tree occupants. A recorded earlier managed launch prevents same-parent replay into that tree. Native creation/removal remains Herdr's job.

   Save launch, native child session and pane IDs from the receipt. Verify the returned native session identity and directory. Do not infer ownership from a name or workspace group. The new Coder must be a real main: neither Intercom lineage variable may be set. Never strip flags or environment variables to pass that check.

4. The delivery owner reads `configs/managed-coder.md` and launches sequential leaves through `launch_agent({name,role:"worker",cwd,task})`, then fresh `reviewer` and separate `reviewer-security` where required. Profiles in `configs/session-roles.json` supply qualified models, explicit efforts and complete contracts in actual task prompts. For either review role, explicitly select `reviewFamily:"openai"` for Anthropic-authored output or `reviewFamily:"anthropic"` for OpenAI-authored output (including Astra). The role's `reviewModels` selects Sol or Opus respectively while its xhigh effort stays independent; omission retains the default Sol. Code leaves require the owner's original admission record, current native UUID/file/pane and same task tree. They add no worktree or persistent writer claim. Non-code roles use the native paths in `configs/delegation.md`. Allow at most three implementation/review rounds.

5. End turns after launch. Use standalone Intercom send/ask/reply with exact peer IDs. No answer or expired ask blocks dependent work. Inspect with `herdr agent get <recorded-pane>` and `herdr agent read <recorded-pane> --source recent-unwrapped --lines 120`. Immediately before any native prompt or close, run `herdr agent get <recorded-pane>` and require its session UUID to match the original recorded UUID; missing or mismatched identity stops the action. Continue a settled verified owned session with `herdr agent prompt <recorded-pane> '<Owner outcome and bounded continuation>'`. Preserve original native identities and command exits. No automatic retry, restart, question ledger, compatibility runner or second actor registry. Never substitute a model answer for human approval.

Unresolved project trust stops task delivery. A human must resolve the native prompt, or the caller must explicitly choose `noProjectResources`. Agents never answer trust/auth prompts. For an uncertain native start or delivery, inspect the returned pane and saved identity before recovery. Keep partial state and do not launch a duplicate writer.

## Acceptance and cleanup

For an isolated trivial-config/prose delivery, its original full main may launch reviewer/security-review in the same canonical tree after successful fixer/writer completion. Original persistent UUID/file ownership, native identity, exclusive admission and no live/uncertain predecessor are required. Before requesting review the parent must inspect completion, command results and owned subprocess exits. Missing exits or unknown actors block handoff even if structural admission passes. No new attestation parameter or registry grants this authority.

The parent verifies the integrated outcome after independent review. The Coder returns changed paths, complete diff, check results, native session/file/pane IDs, unresolved decisions and actor/command exit evidence, then remains idle for parent-owned shutdown.

Cross-check the task plan against original native launch/session/pane and command evidence. Missing or conflicting identity means keep the tree. Establish that every owned leaf and command descendant finished. Immediately before closing, verify `herdr agent get <recorded-pane>` still binds the pane to the original recorded session UUID; missing or mismatched identity stops the action. Use settled confirmed-owned `herdr pane close <recorded-pane>` and inspect native/process state afterward. Busy-stop safety is not established. A completed report, pane-close receipt, idle label or absent pane does not prove command descendants exited. Unknown/running actors or unanswered decisions block cleanup.

Only the authorized launching parent removes the native workspace after merge or authorized abandonment. Immediately before removal, freshly read `herdr workspace list` and match the exact recorded workspace_id to checkout_path, repo_key and `is_linked_worktree: true`. A mismatch, absence or unreadable identity means keep it.

Inspect the task Git admin directory for `pawprint-writer.json` and `pawprint-writer.lock`, including symlinks. Freshly read `herdr agent list` and canonicalize each visible cwd and foreground_cwd for same-tree occupants. For a vanished path, canonicalize its existing parent and use lstat to prove the final entry absent rather than a dangling symlink. Missing ancestors, unresolved links, permission errors or unknown identity block removal. Any legacy claim or lock blocks this cleanup; never remove or bypass it.

Preserve needed ignored artifacts and delivery evidence before non-force removal:

```sh
herdr worktree remove --workspace <recorded workspace_id>
```

Verify native and Git readback afterward. A dirty refusal means keep and inspect, never force. Native removal leaves the branch. No tool performs cleanup on its own; the parent runs it after the checks above.

### Merged-branch deletion

Deleting the delivery's merged task branch is part of the authorized delivery; no separate approval is needed. Keep abandoned/unmerged branches unless separately authorized. Prerequisites: verified merge, every actor/claim/occupant check above, and successful verified tree removal. Record the reviewed PR's merged head SHA and its publication remote at merge time; every deletion check below compares against that recorded head.

Local: confirm the PR is merged and the local branch tip equals the recorded head (`git -C <source repo> rev-parse refs/heads/<branch>`). Run `git -C <source repo> branch -d <branch>`. If `-d` refuses only because a squash or rebase merge left no ancestry, `git -C <source repo> branch -D <branch>` is permitted after those exact-head and merged-PR checks. Any other refusal, an unknown tip or a mismatched tip means keep the branch. This permission is narrow: it never covers force-removing worktrees or rewriting shared history.

Remote: only where the parent already holds publication authority for the repository. Immediately before deletion, read the published tip with `git -C <source repo> ls-remote <recorded remote> refs/heads/<branch>`. A failed or unreadable lookup means keep the branch. A successful lookup that finds no ref needs no deletion. A tip that differs from the recorded head means keep it. On equality run `git -C <source repo> push <recorded remote> --delete <branch>`; add no force flags.

Legacy `release_worktree` still releases only its UUID/file-bound owner's recorded pre-pane failure claim. Post-start or uncertain claims stay held. It never removes a worktree or branch. The managed Coder has no authority to close its pane or remove native resources merely because review finished.
