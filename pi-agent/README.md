# pawprint 🐾

My [pi](https://github.com/earendil-works/pi-coding-agent) configuration — the mark
this setup leaves on any machine. Live repo: this directory *is* `~/.pi/agent`,
with a default-deny `.gitignore` (nothing tracked unless allowlisted), so runtime
state and secrets can never be committed by accident.

Tracked: `settings.json` (incl. the `packages` manifest), `models.json`,
`mcp.json`, `AGENTS.md`, `presets.json`, `agents/`, selected `extensions/`,
`setup.sh`, this file.

Never tracked: `auth.json`, MCP OAuth caches, `sessions/`, package clones
(`git/`), caches, `trust.json`.

## Fresh-machine restore

1. **Prereqs**: node 24 (mise), fish, `gh auth login`.
2. **Env**: export `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID`
   (e.g. `~/.config/fish/conf.d/pi.fish`). `models.json` references them as
   `{VAR}` placeholders — pi resolves them at request time, so no gateway URL
   lives in this repo.
3. **Internal MCP servers**: company-internal entries live in
   `~/.config/mcp/mcp.json` (the adapter merges config layers; see
   pi-mcp-adapter's precedence docs). Only public SaaS servers are in this
   repo's `mcp.json`. Recreate your internal layer there if you have one.
4. `git clone <this-repo> ~/.pi/agent` *(before first pi run)*
5. `~/.pi/agent/setup.sh` — installs pi + agent-browser (+ runtime), reinstalls
   every package from the `settings.json` manifest (skips present clones),
   adds the gh-dash extension.
6. **Manual auth**: `/login cloudflare-ai-gateway` (or env), then in pi:
   `/mcp-auth` per OAuth server, `/trust` per project.
7. **Verify**: `pi --list-models` shows your models; `git status` is clean;
   `/mcp` lists all expected servers; `git diff settings.json` is empty
   (if a `pi install` rewrote an entry, `git checkout -- settings.json`).

## Also installed by setup.sh

- `ghostty/config.ghostty` → `~/Library/Application Support/com.mitchellh.ghostty/`
  (the file Ghostty honors; XDG path gets a pointer). Canonical copy is HERE —
  edit the repo file, re-run setup.sh, `cmd+shift+,` in Ghostty.

## Not covered here

- `pr-watch` / `pr-review` / gh-dash config — separate projects, separate repos
- cheat sheets (`~/.config/cheat/`) — dotfiles territory
- shell env itself (`~/.config/fish/`) — your dotfiles (pi needs the two
  `CLOUDFLARE_*` vars; see above)

## Editing rules

- Edit files in place; commit. The live config *is* the repo — no sync step.
- `models.json` uses `{ENV_VAR}` placeholders — never paste the resolved URL in.
- If you ever add a file you want tracked, allowlist it in `.gitignore`
  deliberately. Everything new is ignored by default; keep it that way.
