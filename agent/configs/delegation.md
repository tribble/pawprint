# Headless delegation

Pi 1.5.0 or later and the `tribble/pi-subagents` source pin in `settings.json` are required for `delegate.thinking`. The fork is 0.52.16 plus the child-thinking commit; released 0.52.16 does not provide this field. Only a main session delegates, one child level deep. Use the public tool:

```js
delegate({
  prompt: "Owner outcome:\n<verbatim ask>\n\nRole: <contract below>\n<bounded task, cwd, evidence and authority>",
  name: "worker",
  cwd: "/absolute/task/worktree",
  model: "cloudflare-ai-gateway/gpt-6.1-sol",
  thinking: "high",
  context: "fresh"
});
```

The prompt carries the entire role and assignment. Names are labels, not loaded profiles. Every call must supply explicit `thinking` from the role contract below, independently of `model`. The upstream field is optional: omission still inherits the parent's effort. Do not change parent thinking or append model suffixes to set child effort. Saved continuations and live guidance retain the child's effort even after parent thinking changes. Pi clamps effort to model capabilities; a launch receipt's requested value is not proof of effective effort.

There is no `agent`, `task`, `async`, profile override, fallback list or tool-mask field. End the turn after launch; completion arrives asynchronously. `agent_runs` supports list, inspect, continue and stop. Stop and verify owned actors and command descendants before the next writer or cleanup.

Include these shared constraints in every prompt: execute your assigned role without recursive wrapping; do not delegate or launch panes; preserve unrelated work; obey the supplied execution venue; no publication or native lifecycle authority unless explicitly assigned. Report changed paths, command exits, evidence and remaining risks. Use ordinary Intercom for decisions. No answer means blocked work.

## Role contracts to include in prompts

- **worker / fixer** — `cloudflare-ai-gateway/gpt-6.1-sol`. Worker: `thinking:"high"`; fixer: `thinking:"low"`. Implement the complete bounded task using existing patterns. Inspect status, callers and acceptance before editing. Add focused regression coverage and run the required checks. Fixer is only for trivial configuration. Do not expand scope or repair orchestration.
- **reviewer / reviewer-security** — `cloudflare-ai-gateway/claude-opus-5-5`, `thinking:"xhigh"`. Use `thinking:"medium"` only for a quick small low-risk review. Independent fresh-context, read-only review against the verbatim owner outcome and complete diff. Inspect connected code and run relevant non-destructive checks. Security review focuses on trust, lineage, authority, credential exposure and lifecycle boundaries. Return evidence-backed findings with paths and severity, or `No blocking findings.` Missing evidence means an incomplete review, not sign-off. Do not implement fixes.
- **writer** — `cloudflare-ai-gateway/claude-fable-5-1`, `thinking:"medium"`. Author only the requested prose artifact in the task worktree. Preserve supplied facts and decisions. Do not turn chat explanations into artifact text or change code.
- **scout / context-builder** — `cloudflare-ai-gateway/claude-sonnet-5-5`, `thinking:"medium"`. Read-only reconnaissance. Return relevant paths, call boundaries, evidence and gaps. Do not run full suites or author an implementation.
- **oracle** — `cloudflare-ai-gateway/gpt-6.1-sol`, `thinking:"high"`. Diagnose a hard technical question from supplied evidence. Return the concrete cause, evidence and smallest proposed repair; do not edit code.
- **debugger** — `cloudflare-ai-gateway/gpt-6-astra`, `thinking:"high"`. Reproduce and diagnose within the brief's execution policy. Return evidence and a bounded repair proposal. Route resulting code through the managed worker.

These are prompt instructions, not enforced read-only permissions. Pass the qualified model in the actual `model` argument and role effort in `thinking`. An unavailable model is an error; do not silently choose another.
