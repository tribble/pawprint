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
export const getMarkdownTheme = () => ({});

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
// Mirror of pi's serializeConversation (compaction/utils.js): user/assistant/toolResult only;
// assistant thinking and tool calls get their own lines; tool results capped at 2000 chars.
export function serializeConversation(messages) {
  const text = (c) => (typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""));
  const trunc = (t, n) => (t.length <= n ? t : `${t.slice(0, n)}\n\n[... ${t.length - n} more characters truncated]`);
  const parts = [];
  for (const m of messages) {
    if (m.role === "user") {
      const c = text(m.content);
      if (c) parts.push(`[User]: ${c}`);
    } else if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const thinking = blocks.filter((b) => b.type === "thinking").map((b) => b.thinking);
      const calls = blocks
        .filter((b) => b.type === "toolCall")
        .map((b) => `${b.name}(${Object.entries(b.arguments ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`);
      if (thinking.length) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
      if (blocks.some((b) => b.type === "text")) parts.push(`[Assistant]: ${text(m.content)}`);
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (m.role === "toolResult") {
      const c = text(m.content);
      if (c) parts.push(`[Tool result]: ${trunc(c, 2000)}`);
    }
  }
  return parts.join("\n\n");
}
