// Times observed current-session work in Pi's native busy row. Child displays stay
// with their owning extensions; retry and compaction keep Pi's native indicators.
import { keyText, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function currentAgentProgress(pi: ExtensionAPI) {
  type Activity = { label: string; started: number };
  const tools = new Map<string, Activity>();
  let model: Activity | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function refresh(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const activity = tools.values().next().value ?? model;
    if (!activity) {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
        ctx.ui.setWorkingMessage();
      }
      return;
    }
    const seconds = Math.max(0, Math.floor((Date.now() - activity.started) / 1000));
    const interrupt = keyText("app.interrupt");
    ctx.ui.setWorkingMessage(`${activity.label} · ${seconds}s${interrupt ? ` (${interrupt} to interrupt)` : ""}`);
    timer ??= setInterval(() => refresh(ctx), 1000);
  }

  function reset(_event: unknown, ctx: ExtensionContext) {
    tools.clear();
    model = undefined;
    refresh(ctx);
  }

  // agent_start also fires before recovery work. context means an actual model request.
  pi.on("context", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    model = { label: "Model working", started: Date.now() };
    refresh(ctx);
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    model = undefined;
    refresh(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    model = undefined;
    const name = event.toolName.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 48) || "tool";
    tools.set(event.toolCallId, { label: `Running ${name}`, started: Date.now() });
    refresh(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    tools.delete(event.toolCallId);
    refresh(ctx);
  });
  pi.on("agent_end", reset);
  pi.on("session_before_compact", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  pi.on("session_start", reset);
}
