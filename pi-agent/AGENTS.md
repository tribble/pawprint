# Global instructions

- Use subagents for non-trivial work. Delegate implementation to `worker`, recon to `scout`, and hard debugging to `oracle` or `debugger`.
- Defer light work (typo fixes, small renames, mechanical edits) to a cheap model: run `fixer` or a `worker` with a minimax/glm override instead of burning frontier tokens.
- Close substantial work sessions with `/extract-process-improvements` (in the print's prompts/) so durable lessons land in this file instead of evaporating.
- Before a PR is ready, run a `reviewer` subagent on the diff and repeat after fixes until it reports no blocking findings (reviewer runs gpt at xhigh via settings.json agentOverrides). For risky or security-relevant changes, add `reviewer-security`.
- When a background subagent gets blocked or needs a product decision, have it ask me through intercom instead of guessing.
- Fleet delegation (herdr-native): use headless subagents ONLY for bounded one-shot work (reviews, recon, mechanical transforms, parallel fanout, forked-context runs). For anything the user may want to steer or iterate, spawn a named herdr workspace agent instead (`/delegate <name> <task>` from herdr-fleet.ts; or `herdr workspace create` → `herdr agent start <name> --kind pi` → settle 5s → `herdr agent prompt`). Relay results as ONE addressed notification line (`✅ <name> — <outcome>`), never a transcript; the user replies in that agent's pane (herdr agent/intercom names are the same namespace). `/fleet` renders the live status surface.
- Model launch discipline: subagent-tool delegation uses the `*-kimi` agents — they pin model+thinking in their frontmatter, so the definition IS the guarantee (no launch-time model decisions to get wrong). herdr pane launches (`/delegate`, `herdr agent start`) take NO `--model` flag: they inherit `defaultModel` (kimi-k3). Never pass a bare model id to `--model` (catalog-only resolution = ambiguity error); if an override is ever needed, the qualified form is `cloudflare-ai-gateway/accounts/fireworks/models/kimi-k3`. Anthropic/GPT pane launches only on explicit user request. Thinking-allocation principle: spend thinking where verification happens (reviewers at max/xhigh), keep interactive turns at high (latency is the real cost); background agents can afford max because nobody watches the spinner.
- Fleet agents (ws/herdr sessions) you spawn are YOUR responsibility to report on: every brief must instruct the agent to intercom your session on completion or blockage, and you relay to the user. The user walking over to an agent's pane is the exception, never the expected flow.
- Status relays name the owner of every open item ([mine] / [agent] / [yours]) — an item without an owner stalls silently. And endorsing an agent's proposed default TO THE USER is not instructing the agent: if an agent awaits direction, send the direction to ITS intercom.

## Skepticism discipline (any claim that the world changed)

Check assumptions → make the change → verify the result.

1. BEFORE — name the load-bearing assumption and test it before doing the work: reproduce the bug before fixing it, validate the key/path/flag against the parser before editing the config, prove a file's inertness by checking what actually reads it in that location. Strongest source wins: parser over docs, behavior over docs, live state over memory.
2. AFTER — verify the end state through a different channel than the one that made the change: exercise the user's actual goal for real (click the link, boot a fresh process, read the file back). The apply-command's own success output is not evidence. If the repo encodes a check (test suite, validate script), the change is not done until that check ran on the FINAL state — "the edit applied" is never the check.
3. If either check isn't possible, say "untested" out loud — never dress it as success.

Same bar as the reviewer rule for PRs: an artifact examined from outside the context that produced it.
- Keep responses concise. Prefer showing diffs and commands over long explanations.
- Answer the question actually asked, first and directly. No defensive over-explaining or base-covering; own mistakes in one sentence, not a post-mortem. Offer background only if asked.
- User has a `cheat [topic]` shell command rendering markdown sheets from `~/.config/cheat/<topic>.md` via glow (default topic `ws`; others include `pr`, `pi`). When adding memorable workflows/commands, offer to update the relevant sheet.

- pawprint = the imprint repo at `~/work/pawprint` (public: tribble/pawprint). `~/.pi/agent` is NOT a git repo — never git-init it again (a live config dir containing auth.json must not be a git root). To KEEP a config change (settings, models, mcp, agents, prompts, extensions): run `~/work/pawprint/scripts/sync-back.sh`, READ the diff it prints — that review is the only guard; tools like the MCP adapter rewrite config between sessions and sync-back will sweep their writes in — then commit AND push from `~/work/pawprint`; an unpushed commit doesn't survive a dead laptop. Fresh machine or drift repair: `~/work/pawprint/setup.sh` (imprint; `--config-only` for the safe subset). Repo-side work (tests, harness, scripts) commits directly in `~/work/pawprint`.
- pi package discipline: clones under `~/.pi/agent/git/` are update-hostile (`pi update` hard-resets + `clean -fdx` + production-installs) — never leave uncommitted work there; commit+push to a branch the moment it matters. Package include/exclude filters in settings.json can only select surfaces the package's own manifest (package.json `pi` field) declares — pi silently ignores includes of undeclared files, so check the manifest first. The tribble forks (pi-mcp-adapter, pi-subagents) are the permanent shipping channel while upstream PRs sit unactioned; `~/work/pawprint/scripts/sync-forks.sh` reports upstream divergence.
- When posting GitHub PR comments or review bodies on the user's behalf (gh pr comment, gh api review/comment calls, etc.), always end the body with the exact signature `— 🐾 agent of @tribble`. Never post unsigned as the user; the marker is load-bearing (pr-watch uses it to tell agent replies from human ones).
- Write PR/issue bodies in the user's voice: first person and concrete ("I hit this on my Mac after the Node upgrade"), never third-person abstractions of the reporter ("macOS users were hit"), no corporate template sections ("What users experienced" / "Why it happens"). Keep the evidence and technical substance; cut the ceremony. Short beats thorough.
- When you open a PR on the user's behalf, register it immediately: `pr-watch track owner/repo#N --agent <your-intercom-session-name>` (discover your name via intercom list/status). pr-watch then steers you inline on review verdicts, CI failures, and human comments; merge/close auto-untracks. The `— 🐾 agent of @tribble` signature doubles as loop-safety: pr-watch won't re-steer you for your own signed replies.

<!-- fitch-pi-kit:baseline:start -->
## Baseline safety and evidence

- Make requested local, reversible changes and run relevant non-destructive checks without repeated permission prompts.
- Ask before external writes, destructive or costly actions, production changes, account or credential changes, security or privacy changes, or material scope expansion.
- Inspect current repositories, documentation, logs, CI, and live state instead of guessing. Preserve unrelated work.
- Before reporting a blocker, check the available evidence and give the concrete recovery action.
- Refresh mutable external state immediately before consequential action or status reporting.
- Do not claim completion until every explicit requirement and the real end state have fresh evidence.
- Commit only when requested or agreed. Stop before push, merge, publish, deploy, or other external mutation unless the user explicitly authorized it.
<!-- fitch-pi-kit:baseline:end -->
