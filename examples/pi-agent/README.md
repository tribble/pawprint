# Controlled pi agent dir for the examples

Every pi invocation in the shipped examples (candidates, graders, summarizer)
runs with `PI_CODING_AGENT_DIR` pointing at THIS directory plus
`--no-approve`, so a comparison's effective pi configuration is exactly what
is committed here — never the ambient `~/.pi/agent` (credentials, skills,
MCP servers, custom tools, whatever models.json is live that week) and never
project-local `.pi/` settings in the working directory.

- `models.json` declares only the two models under comparison (fable 5.1 and
  GPT-6 Astra behind a Cloudflare AI Gateway). The `{CLOUDFLARE_ACCOUNT_ID}` /
  `{CLOUDFLARE_GATEWAY_ID}` placeholders — and the provider credential itself —
  come from the runtime environment of whoever launches the run, same as any
  pi provider config. No `auth.json` lives here; credentials must never be
  written into this dir (its contents are snapshotted into the results tree).
- Add a `SYSTEM.md` or `APPEND_SYSTEM.md` here if the comparison should pin a
  system prompt; absent files mean pi's defaults.
- Only `models.json`, `settings.json`, `SYSTEM.md` and `APPEND_SYSTEM.md` may
  live here (this README.md is ignored). The runner refuses the whole run —
  before reading, copying, or spawning anything — if it finds credentials
  (`auth.json`/`mcp-auth.json`), runtime state (`sessions/`, …), symlinks, or
  subdirectories.
- Once per invocation, before any child is launched, the runner snapshots
  those bytes into `<results>/.agent-config/<sha256>/`. The hash is part of
  the attempt input and grading protocol identity: a changed config under an
  existing candidate id is rejected on rerun, and an edit deliberately starts
  a new grade revision. No child executes this dir or the archive: each child
  gets a private per-process copy (pi writes runtime state into its agent
  dir), removed when the child finishes. A mutation here mid-run cannot reach
  another arm of the same invocation.
