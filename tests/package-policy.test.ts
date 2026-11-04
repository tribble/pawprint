import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./fixture.ts";

test("pi-answer source config sets hintModels to an empty list", () => {
  const config = JSON.parse(readFileSync(join(REPO, "agent/configs/answer.json"), "utf8")) as { hintModels?: unknown };
  assert.deepEqual(config.hintModels, []);
});
