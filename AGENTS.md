# pawprint — for the pi agent that just `cd`'d in

This is not a project. It is a *print* of one person's (tribble's) pi config:
`pi-agent/` mirrors the layout of a `~/.pi/agent` directory; `manifest.json`
lists exactly which files ship and what each is for. Your user's live config
is their own `~/.pi/agent`; nothing here touches it unless you run `setup.sh`.

## Look, then pick

```sh
./setup.sh --list                       # the catalog: [{path, does, needs, personal}] as JSON
./setup.sh --dry-run --only <path>...   # plan: what would be copied where, nothing written
./setup.sh --only <path>...             # copy just those files into ~/.pi/agent (or --target DIR)
```

- `does` says what a piece does in plain terms; `needs` names what it assumes
  is installed (`herdr`, `pr-watch`, `pi-subagents`, a Cloudflare AI Gateway,
  another catalog path, …). No `needs` → the file stands alone.
- `personal: true` means the file encodes tribble's own choices — models,
  gateway account, rules, repo paths. Read it and adapt it for your user;
  never copy it blind. `--only` warns on stderr for each such file and copies
  it anyway.
- Existing files that differ are backed up next to themselves as
  `<path>.bak-pawprint-<timestamp>` before being overwritten; nothing is deleted.

## Never

- Bare `./setup.sh` refuses to run. `--all` is the full imprint: it writes the
  *whole* print over the live config and then runs machine setup (installs,
  package list, terminal config). Backups are made — it is still not what a
  visitor wants. Always `--only`, and `--dry-run` first.
- Don't edit `pi-agent/AGENTS.md`: those are the owner's rules, not yours.

## Everything else

- How a piece works is in the header comment of the file itself
  (`pi-agent/<path>`); read that before installing it.
- `npm test` and `scripts/validate.sh` are the print owner's tooling (they
  check tribble's machine against the print) — not needed to adopt anything.
- Questions or a broken piece → open an issue on the repo.
