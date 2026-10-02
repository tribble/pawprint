// models.json gateway contract: the local Opus 5.5 workaround. Pi's bundled
// cloudflare-ai-gateway catalog ships id `claude-opus-5.5`, which the gateway
// 404s (it wants `claude-opus-5-5`); models.json cannot rename a catalog id
// (ModelOverrideSchema has no `id`), so a custom model carries the correct
// request id on the same Anthropic-through-Cloudflare route — and no
// fallback, so a smoke probe can't silently pass on another model. Durable checks
// only: config content, composed by the REAL installed pi runtime
// (ModelRuntime over ModelConfig.load — schema-validating, credential-blind,
// no network) in a clean subprocess, because this suite's loader stubs
// `typebox` and the real parser needs the real one. Nothing here reads git
// HEAD or live state; authPath is a scratch file in gitignored .artifacts
// (the runtime writes an empty `{}` store there; it never sees real credentials).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./fixture.ts";

const AGENT = join(REPO, "agent");
const readJson = (rel: string) => JSON.parse(readFileSync(join(AGENT, rel), "utf8"));

const QUALIFIED = "cloudflare-ai-gateway/claude-opus-5-5";
const BROKEN = "cloudflare-ai-gateway/claude-opus-5.5";

type ComposedModel = {
  id: string;
  provider: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: { allowedFallbackModels?: unknown[] };
  thinkingLevelMap?: Record<string, string | null>;
};
type Composed = { configError?: string; models: ComposedModel[] };
function compose(): Composed {
  const script = `
    const base = ${JSON.stringify(pathToFileURL(join(REPO, ".pi-types/@earendil-works/pi-coding-agent/dist/core/")).href)};
    const { ModelRuntime } = await import(base + "model-runtime.js");
    const rt = await ModelRuntime.create({
      authPath: ${JSON.stringify(join(REPO, ".artifacts/nonexistent-auth.json"))},
      modelsPath: ${JSON.stringify(join(AGENT, "models.json"))},
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    console.log(JSON.stringify({ configError: rt.getError?.(), models: rt.getModels() }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim());
}

test("models.json: parses and composes clean through pi's real runtime", () => {
  assert.equal(compose().configError, undefined);
});

test("models.json: claude-opus-5-5 composes on the same gateway anthropic route as claude-opus-5, native Opus 5.5 metadata", () => {
  const { models } = compose();
  const gateway = models.filter((m) => m.provider === "cloudflare-ai-gateway");
  const opus5 = gateway.find((m) => m.id === "claude-opus-5");
  const opus55 = gateway.find((m) => m.id === "claude-opus-5-5");
  assert.ok(opus5, "old Opus 5 preserved");
  assert.ok(opus55, "claude-opus-5-5 composed");
  assert.equal(opus55.baseUrl, opus5.baseUrl, "same Anthropic-through-Cloudflare route");
  assert.equal(opus55.api, "anthropic-messages");
  assert.equal(opus55.reasoning, true);
  assert.deepEqual(opus55.input, ["text", "image"]);
  assert.deepEqual(opus55.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.equal(opus55.contextWindow, 320000, "local 320k cap convention");
  assert.equal(opus55.maxTokens, 128000);
  assert.equal(opus55.compat?.allowedFallbackModels, undefined, "no fallback: the probe must exercise this exact route");
  // pi-ai getSupportedThinkingLevels: only explicit null disables a level,
  // so the full native map is required — a partial map would advertise
  // off/minimal as supported.
  assert.deepEqual(opus55.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, "native thinking map");
});

test("settings.json: scope selects the dashed qualified ID, never the dotted catalog one", () => {
  const enabled: string[] = readJson("settings.json").enabledModels;
  assert.ok(enabled.includes(QUALIFIED), `${QUALIFIED} in enabledModels`);
  assert.ok(!enabled.includes(BROKEN), `${BROKEN} gone from enabledModels`);
});
