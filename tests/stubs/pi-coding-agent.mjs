// Stub for runtime imports from @earendil-works/pi-coding-agent.
// getAgentDir is mutable per-test: setAgentDir() BEFORE importing the
// extension under test (auto-update.ts captures it at module load).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentDir = mkdtempSync(join(tmpdir(), "pawprint-agentdir-"));

export function setAgentDir(dir) {
  agentDir = dir;
}
export function getAgentDir() {
  return agentDir;
}
export const CONFIG_DIR_NAME = ".pi";

export class DynamicBorder {
  constructor() {}
}
