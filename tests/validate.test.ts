// validate.sh: the read-only machine-vs-print audit. Fresh imprint → green;
// one drifted file → names exactly that file; missing env var → fails naming it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const ENV_OK = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: "SENTINEL-ACCOUNT-9f8",
  CLOUDFLARE_GATEWAY_ID: "SENTINEL-GATEWAY-2b7",
};

function imprint(t: string) {
  execFileSync("bash", [join(REPO, "setup.sh"), "--target", t], { encoding: "utf8" });
}
function validate(t: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [join(REPO, "scripts", "validate.sh"), "--target", t], {
    encoding: "utf8",
    env,
  });
}

test("fresh imprint → validate green, exit 0", () => {
  const t = mkdtempSync("pawprint-v1-");
  imprint(t);
  const r = validate(t, ENV_OK);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes("VALID: machine matches the print"));
  assert.ok(!r.stdout.includes("drift:") && !r.stdout.includes("missing:"));
  assert.ok(r.stdout.includes("tool ok:"), "tools audited");
});

test("one drifted file → validate fails naming exactly that file", () => {
  const t = mkdtempSync("pawprint-v2-");
  imprint(t);
  writeFileSync(join(t, "settings.json"), readFileSync(join(t, "settings.json")) + "\n");
  const r = validate(t, ENV_OK);
  assert.equal(r.status, 1);
  const drift = r.stdout.split("\n").filter((l) => l.startsWith("drift:"));
  assert.deepEqual(drift, ["drift:         settings.json"]);
  assert.ok(!r.stdout.includes("missing:"));
});

test("missing managed file → reported as missing, exit 1", () => {
  const t = mkdtempSync("pawprint-v3-");
  imprint(t);
  execFileSync("rm", [join(t, "mise.toml")]);
  const r = validate(t, ENV_OK);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("missing:       mise.toml"));
});

test("missing env var → validate fails naming it (presence, never values)", () => {
  const t = mkdtempSync("pawprint-v4-");
  imprint(t);
  const env: Record<string, string | undefined> = { ...ENV_OK };
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const r = validate(t, env);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("env MISSING:   CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(!r.stdout.includes("SENTINEL-GATEWAY-2b7"), "values never printed");
});
