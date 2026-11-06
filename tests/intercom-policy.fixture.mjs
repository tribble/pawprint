// Real Pi dispatch, including the built-in codemode tool. No broker or model network.
import assert from "node:assert/strict";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager, VERSION,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import herdrFleet from "../extensions/herdr-fleet.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR;
const faux = fauxProvider({ provider: "policy-proof", api: "policy-proof-api" });
const credentials = { read: async () => undefined, list: async () => [], modify: async () => { throw new Error("No credential writes in this fixture"); }, delete: async () => { throw new Error("No credential writes in this fixture"); } };
const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider);
let unsafeExecutions = 0, ordinaryExecutions = 0, humanCommands = 0;
const settings = SettingsManager.inMemory({ defaultTools: ["intercom", "codemode"], compaction: { enabled: false }, retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({
  cwd: agentDir, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  extensionFactories: [herdrFleet, createCodemodeExtension(), (pi) => {
    pi.registerTool({
      name: "intercom", label: "Intercom dispatch sentinel", description: "Observe execution after policy.",
      parameters: Type.Object({ action: Type.String(), cwd: Type.Optional(Type.String()), openProjectPaneIfMissing: Type.Optional(Type.Boolean()) }),
      execute: async (_id, params) => {
        if (params.openProjectPaneIfMissing) unsafeExecutions++; else ordinaryExecutions++;
        return { content: [{ type: "text", text: "executed" }], details: {} };
      },
    });
    pi.registerCommand("policy-human", { description: "Human command dispatch sentinel", handler: async () => { humanCommands++; } });
  }],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
  cwd: agentDir, agentDir, modelRuntime: runtime, model: runtime.getModel("policy-proof", "faux-1"),
  settingsManager: settings, resourceLoader, sessionManager: SessionManager.inMemory(),
});
const calls = [];
session.subscribe(event => {
  if (event.type === "tool_execution_end" && event.toolName === "intercom") calls.push(event);
});
try {
  await session.bindExtensions({});
  const modelCall = async (nested, params) => {
    const script = `text(await tools.intercom(${JSON.stringify(params)}))`;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(nested ? "codemode" : "intercom", nested ? { code: script } : params), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Exercise dispatch");
  };
  for (const leaf of [false, true]) {
    if (leaf) process.env.PAWPRINT_FLEET_LEAF = "1"; else delete process.env.PAWPRINT_FLEET_LEAF;
    for (const nested of [false, true]) for (const action of ["send", "ask", "handover"]) {
      const before = calls.length;
      await modelCall(nested, { action, cwd: agentDir, openProjectPaneIfMissing: true });
      assert.equal(calls.length, before + 1, JSON.stringify({ active: session.getActiveToolNames(), messages: session.messages.slice(-3) }));
      const result = calls.at(-1);
      assert.equal(result.isError, true, `${action}, nested=${nested}, leaf=${leaf}`);
      assert.match(JSON.stringify(result.result), /auto-project-pane.*blocked/i);
      assert.equal(Boolean(result.parentToolCallId), nested);
    }
  }
  for (const nested of [false, true]) for (const action of ["send", "ask", "handover"]) {
    await modelCall(nested, { action, cwd: agentDir, openProjectPaneIfMissing: false });
    assert.equal(calls.at(-1).isError, false);
  }
  await session.prompt("/policy-human");
  assert.equal(humanCommands, 1);
  assert.equal(unsafeExecutions, 0);
  assert.equal(ordinaryExecutions, 6);
  console.log(JSON.stringify({ pid: process.pid, version: VERSION, blocked: 12, ordinaryExecutions, humanCommands, nestedIds: calls.filter(c => c.parentToolCallId).map(c => c.toolCallId) }));
} finally {
  session.dispose();
}
