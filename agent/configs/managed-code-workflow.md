# Managed code workflow

Any full Pi session uses fresh native herdr worktree → bounded main Coder → worker and independent fresh review for code changes of any size. Only trivial configuration may bypass this flow. Read-only work and non-code authoring use `configs/delegation.md`.

The launching parent owns scope, decisions, final acceptance, authorized publication and native lifecycle. The Coder adjudicates one bounded deliverable, usually one PR, outside the human-facing parent's context. The worker writes code. Existing participants execute their assigned roles without recursive wrapping. A headless child cannot supervise another child or launch a pane. Do not clear lineage to manufacture a main.

Additional full workstream sessions are for substantial independent ownership across deliveries, not routine per-PR wrappers. Preserve legacy claims and their release rules. Never repurpose a claimed or narrowly assigned pane tree or create an unauthorized second scope. A delegated session publishes or deploys only when assigned under owner authority. Already-authorized actions need no repeat approval.

## Native launch

Use Pi 1.5.0 or later with pi-subagents 0.52.14. Restart the Pi process to change SDK versions; `/reload` does not upgrade the host. Verify the actual child SDK, not merely CLI version. Use a persistent saved native parent session. If delegation or native launch fails, preserve the exact error and identities and stop; do not implement inline or retry blindly.

1. Inspect source status and the repository's authorized base/path policy. Refresh relevant Git state and resolve the immutable base immediately before creation. Confirm the branch is unused and the sibling path absent, including dangling symlinks and registered worktrees. Herdr does not fetch. Pawprint uses:

   ```sh
   herdr worktree create --cwd /Users/pantera/work/pawprint --branch <branch> \
     --base origin/main --path /Users/pantera/work/pawprint-<branch> \
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

4. The Coder reads `configs/managed-coder.md` and delegates sequentially using `delegate({prompt,name,cwd,model,context:"fresh"})`. Roles are complete prompt contracts from `configs/delegation.md`, not loaded profiles. Worker model is `cloudflare-ai-gateway/gpt-6.1-sol`; independent reviewer and security-reviewer model is `cloudflare-ai-gateway/claude-opus-5-5`. Thinking is inherited. No effort setter, suffix workaround, fallback catalog or tool masks. Allow at most three implementation/review rounds.

5. End turns after asynchronous launches. Ordinary Intercom send/ask/reply carries decisions. No answer or an expired ask leaves dependent work blocked; the parent handles continuation manually. There is no durable question ledger, automatic restart or historical claim cleanup. `agent_runs` supports list, inspect, continue and stop in the owning native main. Preserve original and successor IDs and command exits. Never assume ancestor forwarding or substitute a model answer for human approval.

Unresolved project trust stops task delivery. A human must resolve the native prompt, or the caller must explicitly choose `noProjectResources`. Agents never answer trust/auth prompts. For an uncertain native start or delivery, inspect the returned pane and saved identity before recovery. Keep partial state and do not launch a duplicate writer.

## Acceptance and cleanup

The parent verifies the integrated outcome after independent review. The Coder returns changed paths, complete diff, check results, child/successor IDs, unresolved decisions and actor/command exit evidence, then remains idle for parent-owned shutdown.

Cross-check the task plan against original native receipts, owned run records and command evidence. Missing or conflicting identity means keep the tree. Establish that every owned child, continuation and command descendant finished. A completed result, Stop receipt, idle pane or absent pane is not proof of closure. Herdr does not account for detached headless writers. Inspect the Coder's public `agent_runs` evidence before its shutdown, plus scoped process evidence for owned commands. Unknown/running actors or unanswered decisions block cleanup.

Only the authorized launching parent removes the native workspace after merge or authorized abandonment. Immediately before removal, freshly read `herdr workspace list` and match the exact recorded workspace_id to checkout_path, repo_key and `is_linked_worktree: true`. A mismatch, absence or unreadable identity means keep it.

Inspect the task Git admin directory for `pawprint-writer.json` and `pawprint-writer.lock`, including symlinks. Freshly read `herdr agent list` and canonicalize each visible cwd and foreground_cwd for same-tree occupants. For a vanished path, canonicalize its existing parent and use lstat to prove the final entry absent rather than a dangling symlink. Missing ancestors, unresolved links, permission errors or unknown identity block removal. Any legacy claim or lock blocks this cleanup; never remove or bypass it.

Preserve needed ignored artifacts and delivery evidence before non-force removal:

```sh
herdr worktree remove --workspace <recorded workspace_id>
```

Verify native and Git readback afterward. A dirty refusal means keep and inspect, never force. Native removal leaves the branch. Only after verified merge and successful tree removal, explicit branch-deletion authority permits `git -C <source repo> branch -d <branch>`. Keep abandoned/unmerged branches unless separately authorized. No automatic cleanup.

Legacy `release_worktree` still releases only its UUID/file-bound owner's recorded pre-pane failure claim. Post-start or uncertain claims stay held. It never removes a worktree or branch. The managed Coder has no authority to close its pane or remove native resources merely because review finished.
