// Zero-dependency test doubles for pi's ExtensionAPI + ExtensionContext.
// Everything records; nothing touches the network, npm, or $HOME.

/** @returns {any} */
export function makeEvents() {
  const handlers = new Map();
  return {
    on(event, h) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
    },
    has(event) {
      return handlers.has(event);
    },
    async emit(event, data) {
      for (const h of handlers.get(event) ?? []) await h(data);
    },
    count(event) {
      return (handlers.get(event) ?? []).length;
    },
  };
}

/** @returns {any} */
export function makePi(overrides = {}) {
  const onHandlers = new Map();
  const execCalls = [];
  const state = {
    thinkingLevel: "medium",
    activeTools: ["read", "bash"],
    model: undefined,
    entries: [],
  };
  const pi = {
    onHandlers,
    execCalls,
    state,
    commands: {},
    flags: {},
    shortcuts: {},
    events: makeEvents(),
    on(event, h) {
      onHandlers.set(event, [...(onHandlers.get(event) ?? []), h]);
    },
    registered(event) {
      return (onHandlers.get(event) ?? []).length;
    },
    async emit(event, ev, ctx) {
      for (const h of onHandlers.get(event) ?? []) await h(ev, ctx);
    },
    registerCommand(name, def) {
      this.commands[name] = def;
    },
    registerFlag(name, def) {
      this.flags[`__def:${name}`] = def;
    },
    registerShortcut(key, def) {
      this.shortcuts[key] = def;
    },
    getFlag(name) {
      return this.flags[name];
    },
    // execImpl: (cmd, args, opts) => ({code, stdout, stderr}) — set per test
    execImpl: overrides.execImpl ?? (async () => ({ code: 0, stdout: "", stderr: "" })),
    async exec(cmd, args, opts) {
      execCalls.push([cmd, ...(args ?? [])]);
      return this.execImpl(cmd, args, opts);
    },
    getThinkingLevel: () => state.thinkingLevel,
    setThinkingLevel(l) {
      state.thinkingLevel = l;
    },
    getActiveTools: () => state.activeTools,
    setActiveTools(t) {
      state.activeTools = t;
    },
    getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
    async setModel(m) {
      state.model = m;
      return true;
    },
    appendEntry(type, data) {
      state.entries.push({ type, data });
    },
  };
  return pi;
}

/** @returns {any} */
export function makeCtx(overrides = {}) {
  const notes = [];
  const statuses = new Map();
  const ctx = {
    cwd: overrides.cwd ?? process.cwd(),
    mode: "tui",
    hasUI: true,
    isIdle: () => overrides.idle ?? true,
    compact: async () => ({ compacted: true }),
    scopedModels: [],
    model: { provider: "anthropic", id: "claude-test" },
    notes,
    statuses,
    reloads: 0,
    async reload() {
      this.reloads += 1;
    },
    modelRegistry: {
      find: (provider, id) => ({ provider, id }),
    },
    sessionManager: {
      getEntries: () => overrides.entries ?? [],
      getSessionFile: () => overrides.sessionFile,
      getSessionId: () => overrides.sessionId,
    },
    ui: {
      notify(msg, level) {
        notes.push({ msg, level });
      },
      setStatus(key, val) {
        if (val === undefined) statuses.delete(key);
        else statuses.set(key, val);
      },
      theme: { fg: (_c, s) => s, bold: (s) => s },
      // custom: tests override to drive selector UIs
      custom: overrides.custom ?? (async () => null),
    },
    ...overrides.spread,
  };
  return ctx;
}

// Poll until cond() is true or the deadline passes; for fire-and-forget
// extension paths (async void handlers, socket writes).
export async function eventually(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}
