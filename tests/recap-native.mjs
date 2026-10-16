// Real SDK/loader boundary; invoked without the unit-test package stubs.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.RECAP_SDK_ROOT ?? resolve("node_modules/@earendil-works/pi-coding-agent");
const sdk = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
const { AssistantMessageEventStream } = await import(pathToFileURL(join(packageRoot, "../pi-ai/dist/index.js")).href);
const scratch = resolve(".artifacts/recap-native");
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, "run-"));
let session;
try {
  let requests = 0;
  let requestContext;
  const answer = "**Where we left off:** The native fixture is ready.\n\n**What's next:** Verify.\n\n**What I need from you:** Nothing.";
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: join(dir, "unused-auth.json"), refreshOnCreate: false });
  runtime.registerProvider("recap-fixture", {
    api: "recap-fixture",
    baseUrl: "https://recap.invalid",
    apiKey: "dummy-fixture-key",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    streamSimple: (model, context, options) => {
      requests++;
      assert.equal(options.sessionId, manager.getSessionId());
      requestContext = structuredClone(context);
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: answer }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });
  const model = runtime.getModel("recap-fixture", "fixture");
  assert(model);
  const manager = sdk.SessionManager.create(dir, join(dir, "sessions"));
  const system = { role: "system", content: "Stored system prompt", timestamp: 1, toolsAdded: [{ name: "read", description: "Never execute this tool for recap", parameters: { type: "object", properties: {} } }] };
  manager.appendMessage(system);
  manager.appendMessage({ role: "user", content: "ANCIENT compacted conversation", timestamp: 2 });
  const kept = manager.appendMessage({ role: "user", content: "ORIGINAL edit target", timestamp: 3 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fixture ready." }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 4, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.appendCompaction("The project is ready for recap verification.", kept, 1000);
  manager.appendContextEdit(kept, { content: "EDITED current task" });
  manager.appendModelChange(model.provider, model.id);
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir: dir,
    settingsManager: sdk.SettingsManager.inMemory(),
    noExtensions: true, additionalExtensionPaths: [resolve("extensions/recap.ts")],
    additionalPromptTemplatePaths: [resolve("prompts")],
    noSkills: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => "Fixture session", appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  ({ session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime, sessionManager: manager, resourceLoader: loader, tools: [], settingsManager: sdk.SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } }) }));
  const runner = session.extensionRunner;
  assert(runner?.getCommand("recap"), "/recap must resolve to a native extension command");
  assert(!session.promptTemplates.some((prompt) => prompt.name === "recap"), "Old recap prompt expansion must be removed");
  let mainRuns = 0;
  session.subscribe((event) => { if (event.type === "agent_start") mainRuns++; });
  session.agent.streamFunction = () => assert.fail("Main prompt loop was invoked");
  const before = structuredClone(manager.buildSessionContext().messages);
  const count = manager.getEntries().length;
  await session.bindExtensions({});
  await session.prompt("/recap");
  for (let attempt = 0; manager.getEntries().length === count && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(requests, 1);
  assert.equal(mainRuns, 0);
  assert.deepEqual(manager.buildSessionContext().messages, before);
  assert.equal(manager.getEntries().length, count + 1);
  const entry = manager.getLeafEntry();
  assert.equal(entry.type, "custom");
  assert.equal(entry.customType, "recap");
  assert.equal(entry.data.text, answer);
  const sent = JSON.stringify(requestContext);
  assert(sent.includes("Stored system prompt") && sent.includes("Never execute this tool"));
  assert(sent.includes("The project is ready") && sent.includes("EDITED current task"));
  assert(!sent.includes("ANCIENT") && !sent.includes("ORIGINAL edit target"));
  assert(sent.includes("Where we left off:") && sent.includes("What I need from you:"));
  assert.equal(requestContext.messages.length, sdk.convertToLlm(before).length + 1);
  assert.deepEqual(requestContext.messages.slice(0, -1), sdk.convertToLlm(before));
  const disk = readFileSync(manager.getSessionFile(), "utf8");
  assert(disk.includes('"customType":"recap"'));
  const reopened = sdk.SessionManager.open(manager.getSessionFile());
  assert.deepEqual(reopened.buildSessionContext().messages, before);
  assert.equal(reopened.getLeafEntry().data.text, answer);
  await loader.reload();
  const extension = loader.getExtensions().extensions.find((ext) => ext.entryRenderers?.has("recap"));
  assert(extension, "Recap renderer must be available on a fresh native load");
  sdk.initTheme("dark", false);
  const restoredView = extension.entryRenderers.get("recap")(reopened.getLeafEntry(), { expanded: false }, { fg: (_color, text) => text });
  const rendered = restoredView.render(80).join("\n");
  assert(rendered.includes("Where we left off:") && rendered.includes("What's next:") && rendered.includes("What I need from you:"));
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  console.log(JSON.stringify({ status: "passed", version, requests, mainRuns, modelContextUnchanged: true, canonicalProjection: "compaction and context edit applied; stored system/tools retained", persistedCustomEntry: true, nativeCommand: true, promptExpansion: false }));
} finally {
  session?.dispose();
  rmSync(dir, { recursive: true, force: true });
}
