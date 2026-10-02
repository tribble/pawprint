// Stub for runtime imports from @earendil-works/pi-ai. StringEnum is the Google-compatible
// string enum for tool schemas; tests never validate against it, so a plain object will do.
export const StringEnum = (values, opts = {}) => ({ type: "string", enum: values, ...opts });

// Mirror of pi-ai's AssistantMessageEventStream (dist/utils/event-stream.js), reduced to what
// tests drive: push() resolves result() on done/error; end() resolves with an explicit value.
export function createAssistantMessageEventStream() {
  const events = [];
  let resolveResult;
  const result = new Promise((r) => (resolveResult = r));
  return {
    events,
    push(event) {
      events.push(event);
      if (event.type === "done") resolveResult(event.message);
      else if (event.type === "error") resolveResult(event.error);
    },
    end(value) {
      if (value !== undefined) resolveResult(value);
    },
    result: () => result,
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

// Mirror of pi-ai's normalizeContext (dist/utils/transcript.js): fold systemPrompt/tools
// into a leading system message; empty prompt and no tools → messages unchanged.
export function normalizeContext(context) {
  const hasPrompt = context.systemPrompt !== undefined && context.systemPrompt.length > 0;
  const hasTools = context.tools !== undefined && context.tools.length > 0;
  if (!hasPrompt && !hasTools) return { messages: context.messages };
  const lead = { role: "system", content: context.systemPrompt ?? "", ...(hasTools ? { toolsAdded: context.tools } : {}), timestamp: 0 };
  return { messages: [lead, ...context.messages] };
}
