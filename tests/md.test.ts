// md.ts: /md [path] appends an "md-view" entry (TUI-only) with the file's text; no arg = the
// last .md path the agent named, newest assistant message first. Read failure → error
// notify, no entry. Pure helpers lastMarkdownPath / expandPath are tested directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePi, makeCtx } from "./harness.mjs";
import md, { expandPath, lastMarkdownPath } from "../extensions/md.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-md-"));
const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text }] } });
const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });

function boot(branch: unknown[] = []) {
  const pi = makePi();
  md(pi);
  const ctx = makeCtx({ cwd: dir });
  ctx.sessionManager.getBranch = () => branch;
  return { pi, ctx, run: (args: string) => pi.commands.md.handler(args, ctx) };
}

test("lastMarkdownPath: last of several; ~ and relative forms; trailing punctuation, quotes and bold fall off; none → null", () => {
  assert.equal(lastMarkdownPath("see /tmp/a.md and ~/b.md, then docs/c.md"), "docs/c.md");
  assert.equal(lastMarkdownPath("Report updated at /tmp/x.md."), "/tmp/x.md");
  assert.equal(lastMarkdownPath("(details in ~/notes/x.md)"), "~/notes/x.md");
  assert.equal(lastMarkdownPath("wrote `./out/x.md`: done"), "./out/x.md");
  assert.equal(lastMarkdownPath("**README.md** updated"), "README.md");
  assert.equal(lastMarkdownPath("edited extensions/md.ts and tests/md.test.ts"), null);
  assert.equal(lastMarkdownPath("plain prose, no files"), null);
  // a `backticked` or "quoted" path keeps its spaces; a phrase in backticks is not a path
  assert.equal(lastMarkdownPath("Report at `/tmp/my report.md`."), "/tmp/my report.md");
  assert.equal(lastMarkdownPath('wrote "~/Notes/todo list.md" for you'), "~/Notes/todo list.md");
  assert.equal(lastMarkdownPath("`notes on x.md and more`"), "x.md");
  // the whole `/md <path>` command in a span names the path after it (the owner hit `/md /tmp/...` → ENOENT on "/md /tmp/...");
  // a space anywhere else stays part of the path, slashes or not
  assert.equal(lastMarkdownPath("You'd read it with `/md /tmp/agents-md-rewrite/AGENTS.new.md`"), "/tmp/agents-md-rewrite/AGENTS.new.md");
  assert.equal(lastMarkdownPath("run `/md report.md` to see it"), "report.md");
  assert.equal(lastMarkdownPath("run `/md docs/a.md` to see it"), "docs/a.md");
  assert.equal(lastMarkdownPath('run "/md ~/a.md" to see it'), "~/a.md");
  assert.equal(lastMarkdownPath("see `/md /tmp/my report.md`"), "/tmp/my report.md");
  assert.equal(lastMarkdownPath("see `/tmp/my project/report.md`"), "/tmp/my project/report.md");
  assert.equal(lastMarkdownPath("see `/mdx notes.md`"), "/mdx notes.md");
  // not markdown files: x.md.bak and URLs (herdr already makes those clickable)
  assert.equal(lastMarkdownPath("Report updated at report.md. Previous backup: previous.md.bak."), "report.md");
  assert.equal(lastMarkdownPath("Report at /tmp/r.md. Reference: [README](https://example.com/README.md)."), "/tmp/r.md");
  assert.equal(lastMarkdownPath("only https://example.com/a.md here"), null);
});

test("expandPath: ~ → home, relative → cwd, absolute untouched", () => {
  assert.equal(expandPath("~/a.md", "/home/u", "/cwd"), "/home/u/a.md");
  assert.equal(expandPath("~", "/home/u", "/cwd"), "/home/u");
  assert.equal(expandPath("~x/a.md", "/home/u", "/cwd"), "/cwd/~x/a.md");
  assert.equal(expandPath("docs/a.md", "/home/u", "/cwd"), "/cwd/docs/a.md");
  assert.equal(expandPath("/tmp/a.md", "/home/u", "/cwd"), "/tmp/a.md");
});

test("/md <path> → md-view entry {path, text}, no notify; renderer shows path header + markdown body; completion's quotes are stripped", async () => {
  writeFileSync(join(dir, "report.md"), "# Report\n\nall good\n");
  writeFileSync(join(dir, "my report.md"), "spaced");
  const { pi, ctx, run } = boot();
  await run("  report.md  ");
  assert.deepEqual(ctx.notes, []);
  assert.deepEqual(pi.state.entries, [{ type: "md-view", data: { path: join(dir, "report.md"), text: "# Report\n\nall good\n" } }]);
  await run('"./my report.md"'); // what pi's file autocomplete inserts for a path with a space
  assert.deepEqual(ctx.notes, []);
  assert.equal(pi.state.entries[1].data.text, "spaced");
  const view = pi.entryRenderers["md-view"]({ data: pi.state.entries[0].data }, { expanded: false }, ctx.ui.theme);
  assert.equal(view.children.length, 2);
  assert.equal(view.children[0].text, `md · ${join(dir, "report.md")}`);
  assert.equal(view.children[1].text, "# Report\n\nall good\n");
});

test("/md (no arg) → last .md the agent named, newest message first; none → warning, no entry", async () => {
  writeFileSync(join(dir, "old.md"), "old");
  writeFileSync(join(dir, "new.md"), "new");
  const { pi, run } = boot([assistant("first pass: old.md"), user("go on"), assistant(`Report updated at ${join(dir, "new.md")}.`), user("thanks"), assistant("Done.")]);
  await run("");
  assert.equal(pi.state.entries.length, 1);
  assert.equal(pi.state.entries[0].data.text, "new");

  // a backticked path with a space opens that file, not the decoy report.md that a bare-token split would hit
  writeFileSync(join(dir, "report.md"), "decoy");
  writeFileSync(join(dir, "my report.md"), "spaced");
  const spaced = boot([assistant(`Report updated at \`${join(dir, "my report.md")}\`.`)]);
  await spaced.run("");
  assert.deepEqual(spaced.ctx.notes, []);
  assert.equal(spaced.pi.state.entries[0]?.data.text, "spaced");

  // the owner's case: the agent backticked the whole `/md <path>` command — absolute and cwd-relative
  writeFileSync(join(dir, "AGENTS.new.md"), "rewritten");
  const cmd = boot([assistant(`You'd read it with \`/md ${join(dir, "AGENTS.new.md")}\``)]);
  await cmd.run("");
  assert.deepEqual(cmd.ctx.notes, []);
  assert.equal(cmd.pi.state.entries[0]?.data.text, "rewritten");
  const rel = boot([assistant("You'd read it with `/md AGENTS.new.md`")]);
  await rel.run("");
  assert.deepEqual(rel.ctx.notes, []);
  assert.equal(rel.pi.state.entries[0]?.data.text, "rewritten");

  // a directory with a space in a backticked path opens that file, not a decoy at the slash-split path
  mkdirSync(join(dir, "project"), { recursive: true });
  mkdirSync(join(dir, "my project"), { recursive: true });
  writeFileSync(join(dir, "project", "report.md"), "decoy");
  writeFileSync(join(dir, "my project", "report.md"), "the real one");
  const spacedDir = boot([assistant(`Report at \`${join(dir, "my project", "report.md")}\`.`)]);
  await spacedDir.run("");
  assert.deepEqual(spacedDir.ctx.notes, []);
  assert.equal(spacedDir.pi.state.entries[0]?.data.text, "the real one");

  const none = boot([assistant("nothing to show"), user("ok")]);
  await none.run("");
  assert.deepEqual(none.ctx.notes, [{ msg: "md: no .md path in the agent's messages", level: "warning" }]);
  assert.equal(none.pi.state.entries.length, 0);
});

test("missing file / directory / non-UTF-8 → error notify naming the path, no entry", async () => {
  const { pi, ctx, run } = boot();
  await run("/nonexistent/x.md");
  await run(dir);
  writeFileSync(join(dir, "bin.md"), Buffer.from([0xff, 0xfe, 0x00]));
  await run("bin.md");
  assert.deepEqual(
    ctx.notes.map((n: any) => [n.level, n.msg]),
    [["error", "md: /nonexistent/x.md: ENOENT"], ["error", `md: ${dir}: EISDIR`], ["error", `md: ${join(dir, "bin.md")}: ERR_ENCODING_INVALID_ENCODED_DATA`]],
  );
  assert.equal(pi.state.entries.length, 0);
});
