---
description: "Start a Linear ticket: worktree + workspace + agent that shapes first"
argument-hint: "<LINEAR-ID> [repo]"
---
Start Linear ticket `$1` as a new workstream. You only coordinate: pick repo, branch type and slug, run `ws create`, hand the new agent ONE line. The agent reads the ticket itself — you never summarize, paraphrase or relay the ticket to it.

1. Arguments. Ticket id `$1` must match `[A-Z][A-Z0-9]+-\d+`; otherwise reply exactly `Usage: /start-ticket <LINEAR-ID> [repo]` and stop. Repo override (empty = infer in step 2): `$2`. If non-empty it must be a key of `repos` in `~/.pi/agent/configs/ws.json`; otherwise list the keys and stop.

2. Read the ticket, read-only: `mcp({ tool: "linear_get_issue", args: { id: "$1" } })` (if that tool is missing, `mcp({ search: "linear issue" })` and use the get-issue tool with the identifier). If the fetch fails, report the error and stop. Change nothing in Linear. Use the ticket ONLY to decide three things:
   - repo: the override if non-empty; else the one `ws.json` repo the ticket's team, project, labels and mentioned paths clearly point to. Not confidently exactly one → stop and ask the user to re-run `/start-ticket $1 <repo>`, naming the candidates. Never guess.
   - type: `fix` (bug, vulnerability, incident), `feat` (feature), `spike` (research, investigation), `chore` (anything else). Not obvious from the ticket → ask, don't guess.
   - slug: 2–5 lowercase words from the title, hyphenated, no filler words, no ticket id (it is already in the branch).

3. Branch = `<type>/$1-<slug>`; the id keeps its case (e.g. `fix/VULN-3431-scope-session-binding`). Run `cd <repo path> && ws create <branch>` as one command. Continue only if `ws` exited 0 AND its output contains `Created worktree` AND exactly one `pi running as agent "<agent-name>"` line; read <agent-name> and <pane-id> from that line. Anything else (`Reusing` = that workstream already exists; `WARNING`; `blocked`; `start manually`; no such line): report the output verbatim and stop — no other branch name, no `--force`, no hand-made worktree or workspace, no starting or repairing pi yourself.

4. Wait until the new pi is listening: `herdr agent wait <agent-name> --until idle --timeout 60000`. If it does not exit 0, report its output verbatim plus <agent-name> and the worktree path and stop — nothing has been sent yet.

5. Hand off ONCE. `<agent-name>` is the quoted name from that line (the lowercased slug — read it from the output, don't derive it). Run exactly:
   `herdr agent prompt <agent-name> "Linear $1. Fetch it yourself with the Linear tools; that ticket is the Owner outcome — quote it verbatim in your first reply. Shape first: use the shape skill — post the mock in this pane and wait for go before changing anything." --wait --until working`
   Substitute only `<agent-name>`. Nothing else about the ticket goes to the agent — no title, no summary, no repo or type hints. If that command did not exit 0: check whether the line landed anyway — `herdr pane read <pane-id> | grep -c "Linear $1\."` (pane-id from the `ws` output). 0 → run the same prompt command once more; ≥1 → it landed, continue. If the retry also fails, report its error verbatim plus <agent-name>, <pane-id> and the worktree path (recovery: prompt it by hand) and stop — no focus. Only after exit 0 (or a confirmed landing): `herdr agent focus <agent-name>`.

6. Reply with one line: `🐑 <agent-name> — shaping $1 on <branch> in <worktree path, ~ for $HOME> (focused)`. If focus did not exit 0, replace `(focused)` with `(focus failed: <error>)` — never report what you did not observe.
