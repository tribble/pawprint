// patch-pi-anthropic-gateway: the manual post-`pi update` repair. Both
// generated locations patch on first run; second run is a no-op; an unknown
// or unwritable layout fails loudly during preflight/staging, before any
// target changes. Fixtures live in the real tmpdir and clean themselves up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "patch-pi-anthropic-gateway");
const API_REL = "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js";
const CHUNK_REL = "dist/bundle/chunks/anthropic-messages-AAAA1111.js";
const OLD_API =
  "new Anthropic({\n" +
  "        apiKey: apiKey ?? null,\n" +
  "        authToken: null,\n" +
  "        baseURL: model.baseUrl,";
const NEW_API =
  "new Anthropic({\n" +
  '        apiKey: apiKey ?? (hasHeader(defaultHeaders, "cf-aig-authorization") ? "" : null),\n' +
  "        authToken: null,\n" +
  "        baseURL: model.baseUrl,";
const OLD_CHUNK = "apiKey:apiKey??null,authToken:null,baseURL:model.baseUrl";
const NEW_CHUNK =
  'apiKey:apiKey ?? (hasHeader(defaultHeaders, "cf-aig-authorization") ? "" : null),authToken:null,baseURL:model.baseUrl';

function fakeRoot(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "pawprint-patch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const api = join(root, API_REL);
  const chunk = join(root, CHUNK_REL);
  mkdirSync(dirname(api), { recursive: true });
  mkdirSync(dirname(chunk), { recursive: true });
  writeFileSync(api, `const x = 1;\n    const client = ${OLD_API}\n        dangerouslyAllowBrowser: true,\n`);
  writeFileSync(chunk, `!function(){${OLD_CHUNK},dangerouslyAllowBrowser:!0}();`);
  return { root, api, chunk };
}

function run(root: string) {
  return spawnSync(SCRIPT, ["--root", root], { encoding: "utf8" });
}

test("first run patches both locations, second run is a no-op", (t) => {
  const { root, api, chunk } = fakeRoot(t);
  const r1 = run(root);
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(r1.stdout.includes(`patched: ${api}`));
  assert.ok(r1.stdout.includes(`patched: ${chunk}`));
  assert.ok(readFileSync(api, "utf8").includes(NEW_API));
  assert.ok(readFileSync(chunk, "utf8").includes(NEW_CHUNK));
  const after = readFileSync(api, "utf8") + readFileSync(chunk, "utf8");

  const r2 = run(root);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.stdout.includes(`already patched: ${api}`));
  assert.ok(r2.stdout.includes(`already patched: ${chunk}`));
  assert.equal(readFileSync(api, "utf8") + readFileSync(chunk, "utf8"), after);
});

test("unknown pattern fails nonzero and does not modify any file", (t) => {
  const { root, api, chunk } = fakeRoot(t);
  writeFileSync(
    api,
    readFileSync(api, "utf8").replace("apiKey: apiKey ?? null,", "apiKey: somethingNew(),"),
  );
  const beforeApi = readFileSync(api, "utf8");
  const beforeChunk = readFileSync(chunk, "utf8");
  const r = run(root);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("unknown layout"), r.stderr);
  assert.equal(readFileSync(api, "utf8"), beforeApi);
  assert.equal(readFileSync(chunk, "utf8"), beforeChunk);
});

test("missing second target fails nonzero; first target stays byte-identical", (t) => {
  const { root, api, chunk } = fakeRoot(t);
  const beforeApi = readFileSync(api, "utf8");
  rmSync(chunk);
  const r = run(root);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("expected 1 file"), r.stderr);
  assert.ok(r.stderr.includes("refusing to touch anything"), r.stderr);
  assert.equal(readFileSync(api, "utf8"), beforeApi);
});

test("unknown second target fails nonzero; first target stays byte-identical", (t) => {
  const { root, api, chunk } = fakeRoot(t);
  const beforeApi = readFileSync(api, "utf8");
  const beforeChunk = readFileSync(chunk, "utf8").replace(OLD_CHUNK, "apiKey:futureV99(),authToken:null");
  writeFileSync(chunk, beforeChunk);
  const r = run(root);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("unknown layout"), r.stderr);
  assert.equal(readFileSync(api, "utf8"), beforeApi);
  assert.equal(readFileSync(chunk, "utf8"), beforeChunk);
});

test("second replace failure rolls back first target, leaks no staged temps", (t) => {
  if (process.platform !== "darwin" || process.getuid?.() === 0) {
    t.skip("uchg immutable flag is macOS-specific; root semantics differ");
    return;
  }
  const { root, api, chunk } = fakeRoot(t);
  const beforeApi = readFileSync(api, "utf8");
  const apiMode = statSync(api).mode;
  const beforeChunk = readFileSync(chunk, "utf8");
  execFileSync("chflags", ["uchg", chunk]);
  let r;
  try {
    r = run(root);
  } finally {
    execFileSync("chflags", ["nouchg", chunk]);
  }
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("error: replace failed"), r.stderr);
  assert.ok(r.stderr.includes("rolled back all completed replacements"), r.stderr);
  assert.ok(!r.stderr.includes("Traceback"), r.stderr);
  assert.equal(readFileSync(api, "utf8"), beforeApi); // rolled back
  assert.equal(statSync(api).mode, apiMode); // original mode restored
  assert.equal(readFileSync(chunk, "utf8"), beforeChunk); // never replaced
  for (const dir of [dirname(api), dirname(chunk)]) {
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.startsWith(".")),
      [],
      `no staged temp siblings left in ${dir}`,
    );
  }
});

test("unwritable second-target dir fails during staging; first target untouched", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores directory write permission bits");
    return;
  }
  const { root, api, chunk } = fakeRoot(t);
  const chunkDir = dirname(chunk);
  chmodSync(chunkDir, 0o555);
  const beforeApi = readFileSync(api, "utf8");
  const r = run(root);
  chmodSync(chunkDir, 0o755); // restore so fakeRoot's t.after cleanup can remove it
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("staging failed"), r.stderr);
  assert.ok(r.stderr.includes("no target was modified"), r.stderr);
  assert.equal(readFileSync(api, "utf8"), beforeApi);
});
