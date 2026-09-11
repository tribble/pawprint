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

// Minimal mirrors of pi's context pipeline (session-manager.ts, messages.ts, compaction/utils.ts):
// entries → AgentMessages → LLM messages → transcript text. Only the shapes the tests exercise.
export function sessionEntryToContextMessages(entry) {
  if (entry.type === "message") return [entry.message];
  if (entry.type === "compaction") return [{ role: "compactionSummary", summary: entry.summary, timestamp: 0 }];
  return [];
}
export function convertToLlm(messages) {
  return messages.flatMap((m) => {
    if (m.role === "compactionSummary")
      return [{ role: "user", content: [{ type: "text", text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${m.summary}\n</summary>` }], timestamp: m.timestamp }];
    if (m.role === "bashExecution") return [{ role: "user", content: [{ type: "text", text: `$ ${m.command}\n${m.output}` }], timestamp: m.timestamp }];
    if (m.role === "custom") return [{ role: "user", content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content, timestamp: m.timestamp }];
    return [m];
  });
}
export function serializeConversation(messages) {
  const text = (c) => (typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => b.text).join(""));
  const label = { user: "[User]", assistant: "[Assistant]", toolResult: "[Tool result]" };
  return messages.map((m) => `${label[m.role]}: ${text(m.content)}`).join("\n\n");
}
