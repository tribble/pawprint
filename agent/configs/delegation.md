# Native delegation

Herdr owns every main, leaf, pane and process lifecycle. Standalone `pi-intercom` owns messaging. There is no headless delegate tool or saved-run controller.

A project Coordinator stays responsive while multiple independent Delivery Leads work concurrently in separate admitted trees. Each Delivery Lead (`delivery-lead`) owns a high-quality change. It launches sequential native worker and fresh reviewer leaves, unblocks them, triggers review, mediates and adjudicates findings, sends valid fixes back to a worker, escalates stuck work and reports results. Neither main writes code. Leaves never launch actors, trigger review or adjudicate their own implementation.

## Owner launch

`launch_agent` reads qualified model, explicit effort and complete role contract from `configs/session-roles.json`. Names are labels, not profiles. Leave `defaultModel` unchanged. Every brief carries the verbatim `Owner outcome:` block and assigned absolute cwd.

When review is needed, choose the opposite model family explicitly: `reviewFamily:"anthropic"` for OpenAI-authored output (including Astra), `reviewFamily:"openai"` for Anthropic-authored output. Only `reviewer` and `reviewer-security` accept it. Their `reviewModels` config selects Opus or Sol respectively; both keep the role's xhigh effort, instruction file and complete contract. Omission keeps the configured default Sol. Invalid selectors or missing configured choices fail before pane creation. The launcher does not infer authorship or change who may commission review.

The launcher submits the task once without waiting for activity, then reads fresh native identity. A successful `prompted` record acknowledges ordered PTY writes, not Pi consumption or execution. Code-leaf admission uses the caller's current native UUID/file/pane and canonical task tree, not launch history. Any live or uncertain launch by the caller into a tree, whatever its role, blocks that caller's later launches there. A Delivery Lead relaunch reports the previous Delivery Lead from the parent's own launch records: name, session, pane, last phase and time, with unknown fields marked unknown.

```js
launch_agent({
  name: "implementation",
  role: "worker",
  cwd: "/assigned/admitted/task/worktree",
  task: "Owner outcome:\n<verbatim ask>\n\n<bounded task, acceptance and authority>"
});
// OpenAI-authored output, including Astra; use openai for Anthropic output.
launch_agent({name:"review", role:"reviewer", reviewFamily:"anthropic", cwd, task});
```

After an Opus worker, both shortcut reviews use OpenAI/Sol.
For OpenAI-authored output, including Astra, use `--review-family anthropic` for both instead.

```text
/delegate --role reviewer --review-family openai --cwd "/same/admitted/tree" <name> <task>
/delegate --role reviewer-security --review-family openai --cwd "/same/admitted/tree" <name> <task>
```

Delivery code leaves (worker, reviewer and reviewer-security) require the caller's current native UUID/file/pane, with its session and execution directory in the same linked task tree. A full session the human asked to take over a tree may continue there. The launcher refuses live agents in the tree and the caller's own uncertain launches. It cannot see a closed predecessor's detached commands: the human or replacement checks predecessor and background-command settlement manually before taking over. The launcher reuses the admission lock, refuses legacy claims and other observed occupants, and adds no worktree or persistent writer claim. Only the owner may start the next leaf after the prior leaf and its commands have verifiably closed. Reviewer/security-review leaves can also be launched by the same full main that originally launched a successful isolated fixer/writer delivery in that canonical tree. The launcher verifies original UUID/file ownership and native identity, exclusive admission and absence of live/uncertain predecessors. The parent must separately inspect completion, command results and owned subprocess exits before requesting review. Missing exits or unknown actors block handoff; pane/roster absence or a final assistant answer is not command-closure proof. Worker launches belong to the tree's delivery owner: its Delivery Lead or a human-requested replacement. An uncertain leaf launch blocks the same canonical tree. Independence requires the original caller-owned record and a recorded tree key matching live Git identity. Missing, invalid or mismatched ownership/tree identity blocks across trees. Historical scout records without a tree key remain unknown.

Fixer (trivial configuration only) and writer require an explicit unclaimed linked task tree. They use the same exclusive admission/occupancy gate without requiring a nested Delivery Lead. Scout, context-builder, oracle and debugger use their explicit assigned directory. These non-code roles need no nested Delivery Lead. Task artifacts still belong in a task worktree.

## Leaf contract

Execute only the role contract and bounded assignment in your task prompt. Preserve unrelated work and obey the supplied execution venue. Do not delegate, launch panes, trigger review or adjudicate your own implementation. No publication or native lifecycle authority is implicit in your role.

Report changed paths, commands and exits, evidence and remaining risks. Use ordinary Intercom for decisions. No answer leaves dependent work blocked. Return once and remain idle for owner verification and settled native closure. Do not close your pane or worktree.

## Roles

| Role | Qualified model | Native thinking | Assignment |
| --- | --- | --- | --- |
| worker | cloudflare-ai-gateway/claude-opus-5-5 | high | Complete bounded implementation, focused regression coverage and required checks. |
| fixer | cloudflare-ai-gateway/claude-opus-5-5 | low | Trivial configuration only, with required checks. |
| reviewer (default / openai) | cloudflare-ai-gateway/gpt-6.1-sol | xhigh | Independent fresh-context read-only intent and complete-diff review. |
| reviewer-security (default / openai) | cloudflare-ai-gateway/gpt-6.1-sol | xhigh | Separate fresh read-only trust, lineage, authority, credential and lifecycle review. |
| reviewer / reviewer-security (anthropic) | cloudflare-ai-gateway/claude-opus-5-5 | xhigh | Review OpenAI-authored output, including Astra. |
| writer | cloudflare-ai-gateway/claude-fable-5-1 | medium | Requested prose only. Preserve facts and decisions. No code. |
| scout / context-builder | cloudflare-ai-gateway/claude-sonnet-5-5 | medium | Read-only paths, call boundaries, evidence and gaps. No full suites. |
| oracle | cloudflare-ai-gateway/gpt-6.1-sol | high | Concrete technical cause, evidence and smallest repair proposal. No edits. |
| debugger | cloudflare-ai-gateway/gpt-6-astra | high | Bounded reproduction and diagnosis. Route code to the owner's worker. |

The launcher includes the selected complete role contract in the actual prompt and passes native `--model` and `--thinking`. Pi clamps effort to model capabilities; verify the effective setting in the native session. Do not change parent effort, invent fallbacks or restrict reviewer tools. Read-only roles are prompt contracts, not a sandbox.

## Messaging and continuation

Use `intercom({action:"status"})` and `intercom({action:"list"})` for real standalone peer IDs. Pawprint claims the native session UUID through the supported identity hook. A rename does not change it. Native replacement uses the new session UUID; resume uses the saved one. Never derive a hashed ID or route by workspace/role label.

Standalone actions are `list`, `list-cwd`, `send`, `ask`, `reply`, `pending`, `status`, `cancel` and `handover`. Use exact IDs and ordinary send/ask/reply. Do not pass bundled-only `scope`, `delivery`, `queueMode` or `last`. Busy delivery is global `steer` or `human-first`, not a per-message option. Model tool requests with `openProjectPaneIfMissing: true` are blocked, including nested codemode calls for send/ask/handover. Explicit human slash commands are a separate native entrypoint; they do not grant model tool authority. Broker acceptance is not proof of recipient persistence or completion.

Immediately before any native prompt or close, run `herdr agent get <recorded-pane>` and verify it still binds that pane to the original recorded session UUID. Missing or mismatched identity stops the action.

End the turn after launch. Reports arrive through Intercom. Inspect with `herdr agent get <recorded-pane>` and `herdr agent read <recorded-pane> --source recent-unwrapped --lines 120`. Continue the same settled native session with `herdr agent prompt <recorded-pane> '<Owner outcome and bounded continuation>'` only while its recorded pane remains open. After independent review the previous worker is closed; verify/close the reviewer and launch a fresh worker with the findings. Do not resend a prompt whose delivery timed out with an uncertain outcome.

A leaf that stopped on a model transport error from network loss or laptop sleep is paused, not finished. Its earlier timeout does not prohibit later contact. Recover it once connectivity returns, as in the network interruption section of `managed-code-workflow.md`: inspect what ran, prefer prompting the same settled verified session with its original brief, and replace it only after verifying settlement.

Owners verify final settlement and command/descendant exits before native `herdr pane close <recorded-pane>`. Inspect native state afterward and close only confirmed-owned settled panes. Busy-stop safety is not established; never stop a busy actor as a routine transition. No result, idle label or pane-close receipt proves detached commands exited. Preserve original launch/session/pane and command evidence. There is no automatic retry, restart, question ledger or second actor registry.
