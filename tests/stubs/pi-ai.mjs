// Stub for runtime imports from @earendil-works/pi-ai. StringEnum is the Google-compatible
// string enum for tool schemas; tests never validate against it, so a plain object will do.
export const StringEnum = (values, opts = {}) => ({ type: "string", enum: values, ...opts });

// Mirror of pi-ai's normalizeContext (dist/utils/transcript.js): fold systemPrompt/tools
// into a leading system message; empty prompt and no tools → messages unchanged.
export function normalizeContext(context) {
  const hasPrompt = context.systemPrompt !== undefined && context.systemPrompt.length > 0;
  const hasTools = context.tools !== undefined && context.tools.length > 0;
  if (!hasPrompt && !hasTools) return { messages: context.messages };
  const lead = { role: "system", content: context.systemPrompt ?? "", ...(hasTools ? { toolsAdded: context.tools } : {}), timestamp: 0 };
  return { messages: [lead, ...context.messages] };
}
