// artifacts.ts: the `artifact` tool appends TUI-only "artifact" entries (add/done); the list is
// their replay on the current branch. /artifacts drives a SelectList: Enter opens (doc → md-view
// entry, else `open`), d drops and re-opens the list, esc closes, empty → info notify.
// The SelectList stub emulates enter / esc / down and records instances in `selectLists`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { selectLists } from "./stubs/pi-tui.mjs";
import { makePi, makeCtx } from "./harness.mjs";
import artifacts, { kindOf, replay, shortRef } from "../extensions/artifacts.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-artifacts-")); // not under $HOME, so paths here show unchanged
const PR = "https://github.com/tribble/dotfiles/pull/1";

function boot() {
  const pi = makePi();
  artifacts(pi);
  const ctx = makeCtx({ cwd: dir });
  // what pi does: appendEntry lands on the branch synchronously as a custom entry
  ctx.sessionManager.getBranch = () => pi.state.entries.map((e: { type: string; data: unknown }) => ({ type: "custom", customType: e.type, data: e.data }));
  const tool = async (params: Record<string, string>) => (await pi.tools.artifact.execute("t1", params, undefined, undefined, ctx)).content[0].text;
  // each /artifacts round builds the picker; the next script step drives it (keys) until done() fires
  const drive = (...steps: ((comp: { handleInput: (input: string) => void }) => void)[]) => {
    ctx.ui.custom = (build: (...args: unknown[]) => { handleInput: (input: string) => void }) =>
      new Promise((done) => {
        const comp = build({ requestRender() {} }, ctx.ui.theme, {}, done);
        steps.shift()!(comp);
      });
  };
  return { pi, ctx, tool, drive, list: () => pi.commands.artifacts.handler("", ctx) };
}

test("kindOf: github pull → PR, /issues/ → issue, other http(s) → link, .md → doc, else file; shortRef: owner/repo#N, ~ for home", () => {
  assert.equal(kindOf(PR), "PR");
  assert.equal(kindOf("https://github.com/tribble/dotfiles/issues/12"), "issue");
  assert.equal(kindOf("https://gitlab.com/g/p/-/issues/3"), "issue");
  assert.equal(kindOf("https://example.com/README.md"), "link");
  assert.equal(kindOf("/tmp/a.md"), "doc");
  assert.equal(kindOf("/home/u/.config/herdr/config.toml"), "file");
  assert.equal(shortRef(PR, "/home/u"), "tribble/dotfiles#1");
  assert.equal(shortRef("https://github.com/tribble/dotfiles/issues/12", "/home/u"), "tribble/dotfiles#12");
  assert.equal(shortRef("https://example.com/x", "/home/u"), "https://example.com/x");
  assert.equal(shortRef("/home/u/.config/herdr/config.toml", "/home/u"), "~/.config/herdr/config.toml");
  assert.equal(shortRef("/tmp/a.md", "/home/u"), "/tmp/a.md");
});

test("add / update / done: one-line results, replay keeps an updated item's slot, ~ @ and relative paths normalise", async () => {
  const { pi, ctx, tool } = boot();
  assert.equal(await tool({ action: "add", ref: PR, title: "herdr artifacts plugin" }), "artifact: PR tribble/dotfiles#1 added (1 in list)");
  assert.equal(await tool({ action: "add", ref: "/tmp/artifacts-proposal.md", title: "artifacts proposal" }), "artifact: doc /tmp/artifacts-proposal.md added (2 in list)");
  assert.equal(await tool({ action: "add", ref: PR, note: "merged" }), "artifact: PR tribble/dotfiles#1 updated (2 in list)");
  assert.deepEqual(replay(ctx), [
    { ref: PR, title: "herdr artifacts plugin", note: "merged" },
    { ref: "/tmp/artifacts-proposal.md", title: "artifacts proposal" },
  ]);
  assert.equal(await tool({ action: "add", ref: "notes.md" }), `artifact: doc ${join(dir, "notes.md")} added (3 in list)`);
  assert.equal(await tool({ action: "add", ref: "@~/x.toml" }), "artifact: file ~/x.toml added (4 in list)");
  assert.equal(replay(ctx).at(-1)?.ref, join(homedir(), "x.toml"));
  assert.equal(await tool({ action: "done", ref: `${dir}/notes.md` }), `artifact: doc ${join(dir, "notes.md")} dropped (3 in list)`);
  assert.equal(await tool({ action: "done", ref: "/nope.md" }), "artifact: doc /nope.md not in list (3 in list)");
  assert.equal(pi.state.entries.length, 6, "5 adds + 1 done; not-in-list appends nothing");
  assert.deepEqual(pi.state.entries.at(-1), { type: "artifact", data: { action: "done", ref: join(dir, "notes.md") } });
  assert.deepEqual(replay(ctx).map((a) => a.ref), [PR, "/tmp/artifacts-proposal.md", join(homedir(), "x.toml")]);
});

test("past 7 items the result carries the worktree nudge", async () => {
  const { tool } = boot();
  for (let i = 1; i <= 7; i++) assert.equal(await tool({ action: "add", ref: `/tmp/f${i}.md` }), `artifact: doc /tmp/f${i}.md added (${i} in list)`);
  assert.equal(await tool({ action: "add", ref: "/tmp/f8.md" }), "artifact: doc /tmp/f8.md added (8 in list) — 8 items; if these are project files they belong in a worktree");
});

test("/artifacts on an empty list → info notify, no picker", async () => {
  const { ctx, list } = boot();
  let shown = 0;
  ctx.ui.custom = async () => (shown++, null);
  await list();
  assert.deepEqual(ctx.notes, [{ msg: "no artifacts registered in this session", level: "info" }]);
  assert.equal(shown, 0);
});

test("/artifacts rows: kind column padded to 5, ref shortened, titles padded so notes align; esc closes without opening", async () => {
  const { pi, ctx, tool, drive, list } = boot();
  const cfg = join(homedir(), ".config/herdr/config.toml");
  await tool({ action: "add", ref: PR, title: "herdr artifacts plugin", note: "merged" });
  await tool({ action: "add", ref: "/tmp/artifacts-proposal.md", title: "artifacts proposal" });
  await tool({ action: "add", ref: cfg, title: "sidebar: one row, active-row colour" });
  await tool({ action: "add", ref: "https://example.com/x" });
  drive((comp) => comp.handleInput("\x1b"));
  await list();
  const pad = "sidebar: one row, active-row colour".length;
  assert.deepEqual(selectLists.at(-1)!.items, [
    { value: PR, label: "PR    tribble/dotfiles#1", description: `${"herdr artifacts plugin".padEnd(pad)}  merged` },
    { value: "/tmp/artifacts-proposal.md", label: "doc   /tmp/artifacts-proposal.md", description: "artifacts proposal" },
    { value: cfg, label: "file  ~/.config/herdr/config.toml", description: "sidebar: one row, active-row colour" },
    { value: "https://example.com/x", label: "link  https://example.com/x", description: "" },
  ]);
  assert.deepEqual(pi.execCalls, []);
  assert.equal(pi.state.entries.length, 4, "esc appends nothing");
  assert.deepEqual(ctx.notes, []);
});

test("Enter opens: URL and non-md file → `open <ref>`, doc → md-view entry inline; a failing open notifies its stderr", async () => {
  const { pi, ctx, tool, drive, list } = boot();
  writeFileSync(join(dir, "report.md"), "# Report\n");
  await tool({ action: "add", ref: PR });
  await tool({ action: "add", ref: "/tmp/config.toml" });
  await tool({ action: "add", ref: "report.md" });

  drive((comp) => comp.handleInput("\r"));
  await list();
  assert.deepEqual(pi.execCalls, [["open", PR]]);

  drive((comp) => { comp.handleInput("\x1b[B"); comp.handleInput("\r"); });
  await list();
  assert.deepEqual(pi.execCalls.at(-1), ["open", "/tmp/config.toml"]);

  drive((comp) => { comp.handleInput("\x1b[B"); comp.handleInput("\x1b[B"); comp.handleInput("\r"); });
  await list();
  assert.equal(pi.execCalls.length, 2, "a doc never shells out");
  assert.deepEqual(pi.state.entries.at(-1), { type: "md-view", data: { path: join(dir, "report.md"), text: "# Report\n" } });
  assert.deepEqual(ctx.notes, []);

  pi.execImpl = async () => ({ code: 1, stdout: "", stderr: "The file /tmp/config.toml does not exist.\n" });
  drive((comp) => { comp.handleInput("\x1b[B"); comp.handleInput("\r"); });
  await list();
  assert.deepEqual(ctx.notes, [{ msg: "artifacts: open /tmp/config.toml: The file /tmp/config.toml does not exist.", level: "error" }]);
});

test("d drops the selected item (done entry) and re-opens the list on the same row, clamped; dropping the last shows the empty notice", async () => {
  const { pi, ctx, tool, drive, list } = boot();
  for (const f of ["a", "b", "c"]) await tool({ action: "add", ref: `/tmp/${f}.md` });

  drive(
    (comp) => { comp.handleInput("\x1b[B"); comp.handleInput("\x1b[B"); comp.handleInput("d"); }, // drop c (row 2)
    (comp) => { assert.equal(selectLists.at(-1)!.selectedIndex, 1, "cursor clamped to the new last row"); comp.handleInput("d"); }, // drop b
    (comp) => { assert.deepEqual(selectLists.at(-1)!.items.map((i: { value: string }) => i.value), ["/tmp/a.md"]); comp.handleInput("\x1b"); },
  );
  await list();
  assert.deepEqual(pi.state.entries.slice(3), [
    { type: "artifact", data: { action: "done", ref: "/tmp/c.md" } },
    { type: "artifact", data: { action: "done", ref: "/tmp/b.md" } },
  ]);
  assert.deepEqual(replay(ctx), [{ ref: "/tmp/a.md" }]);
  assert.deepEqual(pi.execCalls, []);

  drive((comp) => comp.handleInput("d"));
  await list();
  assert.deepEqual(replay(ctx), []);
  assert.deepEqual(ctx.notes, [{ msg: "no artifacts registered in this session", level: "info" }]);
});
