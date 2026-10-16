# Managed code workflow

Any full Pi session uses this flow for code changes of any size: fresh native
herdr worktree → managed Coder → worker and independent review. Small fixes,
renames and mechanical code edits are included. Only trivial configuration
changes can bypass it. If unsure whether configuration is trivial, use this flow.
Read-only work and non-code authoring do not become code work by using an agent.

The launching parent owns scope, decisions, final acceptance, authorized publication
and native lifecycle. For a delegated full session, publication and deployment
must be assigned in its scoped handoff under applicable owner authorization.
Otherwise return evidence for launching-parent acceptance. Proceed without repeat
approval prompts for actions already assigned and authorized.
A Coordinator owns a broad project. Add a full workstream
session only for substantial independent ownership across deliveries, not as a
routine per-PR wrapper. It uses this same flow for each bounded deliverable.
The managed Coder supervises one deliverable, usually one PR, through sequential
implementation, independent review and fixes. The worker writes code.

Existing managed participants keep their assigned roles in their assigned tree;
they never recursively wrap themselves. A leaf or narrowly scoped agent receiving
code work outside this flow stops and requests routing from a capable parent.
It must not create a tree through shell, raise depth or edit inline to bypass this rule.
A claimed or narrowly assigned pane tree cannot become a managed tree. There is
no legacy pane-Coder exception. If that assignment cannot enter the flow within
its authority and scope, escalate to its launching parent. Do not bypass a claim
or create an unauthorized second scope. Existing pane APIs and legacy claims stay intact.

## Launch and recover

Use a persistent saved native parent session, never `--no-session`, so run and
question ownership remains recoverable. Confirm herdr and public managed delegation
are available and the effective depth permits the Coder and its leaves. If a
prerequisite or delegation fails, stop and report the exact error. Do not substitute
shell worktree creation, another pane or inline implementation.

1. Preflight the source repository and its Git status, an unused local branch and
   an absent absolute sibling path, including dangling symlinks and registered
   worktrees. Determine the intended base from the repository's policy and owner
   scope. Refresh the relevant Git state and resolve and record its immutable
   commit immediately before creation. Herdr does not fetch. Do not assume a
   remote name or default branch for other repositories. Pawprint uses `origin/main`
   and `/Users/pantera/work/pawprint-<branch>`:

   ```sh
   herdr worktree create --cwd /Users/pantera/work/pawprint --branch <branch> \
     --base origin/main --path /Users/pantera/work/pawprint-<branch> \
     --label <branch> --no-focus
   ```

2. Read `.result.worktree.path` and `.result.workspace.workspace_id` from the
   successful receipt. Independently verify the returned canonical path, branch
   and HEAD against the intended path/branch/base, and its canonical Git common
   directory against the source repository. Verify it is a linked checkout, with
   a canonical Git admin directory distinct from the common directory. Record
   the canonical path, repository `repo_key`, base commit, exact `workspace_id`
   and persistent parent session identity in a plan inside the task worktree.
   The plan is an index, not the authority for cleanup. Original parent-saved
   native receipts and managed run/question/continuation records are authoritative;
   a child-editable plan cannot replace or overwrite identity or actor evidence.
   Do not predict identities or reuse an existing tree.

3. Delegate through the public managed tool with the actual returned path:

   ```text
   delegate({agent:"managed-coder-trial",cwd:<returned path>,async:true,
     task:<verbatim Owner outcome + scoped brief with assigned absolute path>})
   ```

   Do not set `worktree:true`; the native tree is already isolated. Record the
   returned run ID, child/continuation IDs and task command identities in the plan.
   The managed Coder supervises sequential workers and independent reviewers there.
   Never attach another workstream or pane Coder to the managed task tree.
   Preserve every legacy/uncertain pawprint claim; do not bypass or alter claims.
   PR context grants children no staging, commit, PR, push, merge or deploy authority.
   Assign only actions authorized by the owner request and standing policy.

4. Keep the saved-question chain: the managed Coder retains the worker run/question
   IDs and opens its own saved `contact_supervisor` question to its launching parent.
   Recover with `agent_runs({action:"questions"})` in that same saved parent session.
   Obtain the required authoritative decision, then answer the exact managed run
   and question with `agent_runs({action:"answer",id:<run ID>,questionId:<question ID>,
   message:<authoritative answer>,async:true})`. The Coder returns that saved answer
   to the original worker question. A full workstream owner can explicitly relay
   a decision request to its own parent through Intercom. Questions do not
   automatically forward to ancestors. A model answer cannot replace required
   human approval. A nudge or answer receipt is not completion. Record successor
   IDs when answering or continuing creates a new run.

For an uncertain creation or launch, inspect native worktree/workspace readback,
Git state and saved run/continuation identities before recovery. Keep partial state.
Never blindly retry, launch a duplicate writer or manufacture a trust decision.
Shell access and the installed diff-review plugin suffice; no Coder pane or
activity viewer is required.

## Acceptance and cleanup

The parent verifies the final deliverable against the Owner outcome after
independent review. Review completion alone is not acceptance.

Before cleanup, cross-check the task-local plan's identities and actors against
those original parent-saved native receipts and managed run/question/continuation
records. Use the original saved records and command exit evidence to establish
closure. Missing or conflicting evidence means keep the tree.

Before removal, establish that every recorded task agent and command, including
nested children, continuations and command descendants, has finished. Inspect
saved runs/questions and command exit evidence. A terminal top-level run, Stop
receipt, idle pane or absent pane does not prove all actors finished. Herdr does
not account for detached headless writers. If an actor is unknown or running,
or a decision/answer delivery remains pending, keep the tree.

Only the launching parent may remove it, after merge or authorized abandonment
and with deletion authority. Just before removal, freshly read `herdr workspace list`
and match the exact recorded `workspace_id` row to the recorded canonical
`checkout_path` and `repo_key`, with `is_linked_worktree: true`.
Never use a list position or workspace number.
A missing, mismatched or unreadable identity means keep the tree.

Resolve the tree's Git admin directory with `git -C <path> rev-parse --absolute-git-dir`.
Inspect it for entries named `pawprint-writer.json` or `pawprint-writer.lock`,
including symlinks. Freshly read `herdr agent list` and canonicalize each visible
agent's `cwd` and `foreground_cwd` to check for occupants at or below the task path.
If a visible agent path no longer exists, canonicalize its existing parent and
use `lstat` to prove the final entry absent, not a dangling symlink. Compare
canonical-parent-plus-final-name against the canonical task tree. Known absence
outside that tree is not an occupant. Missing ancestors, unresolved links,
permission errors or unknown identity still block.
Any claim, lock, occupant or unknown/unreadable inspection means keep the tree.
Never remove, release or bypass claims. Visible agents do not account for detached
headless writers; actor completion, decisions and deletion authority remain independent checks.

Non-force removal also deletes ignored files. Preserve needed artifacts and delivery
evidence first. Use `herdr worktree remove --workspace <recorded workspace_id>`
without `--force`, then verify native/Git readback. A dirty refusal means keep and
inspect the tree, not force deletion. Native removal leaves the branch.
Only after verified merge and successful verified tree removal, explicit branch
deletion authority permits `git -C <source repo> branch -d <branch>`.
Keep abandoned/unmerged branches unless separately authorized. No automatic cleanup.

`launch_agent`, human `/delegate`, `/ws` and `release_worktree` remain explicit
pane APIs with their existing claim, trust and authority rules. They do not
provide an alternative code-authoring route. Human `/delegate` is not managed `delegate`.

Authority derives from the owner request, scoped handoff and applicable standing policy.
A role label or interaction mode grants no additional authority.
Publishing, merging and deployment require applicable authorization.
Escalate scope changes and user-owned tradeoffs immediately.
Unanswered approval requests leave dependent work paused.
