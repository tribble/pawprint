// native-mcp.test.ts — the native MCP migration contract (pi's built-in MCP,
// replacing pi-mcp-adapter). Durable desired-state checks only: nothing here
// reads git HEAD, so the suite stays green once this branch becomes HEAD.
// agent/mcp.json: all 11 servers with exact URLs, validated by the REAL
// installed pi parser (validateMcpServerConfig — no connections, no
// header-command execution), Slack's clientId + exact callbackUrl and its
// public direct-tool selection preserved, horizon/alto publishing endpoint +
// codemode exposure only (owner decision: no internal tool inventories in
// tracked files), GitHub's auth as the documented whole-value command header.
// settings.json: adapter package gone, codemode additive. agent/mcp-auth.json
// stays default-deny ignored; cloak.json masks every persisted native secret
// field — fake strings only, through the REAL installed pi-cloak.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, fixtureRepo } from "./fixture.ts";

const AGENT = join(REPO, "agent");
const readJson = (rel: string) => JSON.parse(readFileSync(join(AGENT, rel), "utf8"));

// The real parser of the installed pi, reached through the .pi-types symlink
// (`npm run types`). It validates only — it never connects or runs `!command`
// header values, and neither do we.
type NativeParser = {
  validateMcpServerConfig: (name: string, raw: unknown) => unknown; // config copy, or error string
  mcpNamespace: (server: string) => string;
};
const parser = (await import(pathToFileURL(join(REPO, ".pi-types/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js")).href)) as NativeParser;

const SERVERS: Record<string, string> = {
  "slack-workos": "https://mcp.slack.com/mcp",
  github: "https://api.githubcopilot.com/mcp",
  notion: "https://mcp.notion.com/mcp",
  linear: "https://mcp.linear.app/mcp",
  granola: "https://mcp.granola.ai/mcp",
  "cloudflare-docs": "https://docs.mcp.cloudflare.com/mcp",
  "cloudflare-ai-gateway": "https://ai-gateway.mcp.cloudflare.com/mcp",
  "cloudflare-observability": "https://observability.mcp.cloudflare.com/mcp",
  datadog: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
  horizon: "https://horizon.workos.tools/mcp",
  alto: "https://mcp.workos.cloud/mcp",
};

// The rollback config's frozen scope: the adapter's nine servers (horizon/alto
// lived only in the machine's untracked ~/.config/mcp/mcp.json).
const LEGACY_SERVERS = [
  "slack-workos", "github", "notion", "linear", "granola",
  "cloudflare-docs", "cloudflare-ai-gateway", "cloudflare-observability", "datadog",
];

test("agent/mcp.json: exactly the 11 servers with exact URLs, each accepted by the installed native parser", () => {
  const servers = readJson("mcp.json").mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), Object.keys(SERVERS).sort());
  for (const [name, url] of Object.entries(SERVERS)) {
    assert.equal(servers[name].url, url, `${name} url`);
    const result = parser.validateMcpServerConfig(name, servers[name]);
    assert.ok(typeof result !== "string", `${name}: ${result}`);
    assert.equal(servers[name].exposure, "codemode", `${name} exposure`);
    const toolExposure = (servers[name] as { toolExposure?: Record<string, unknown> }).toolExposure;
    if (toolExposure) assert.ok(!("*" in toolExposure), `${name}: no wildcard direct exposure`);
  }
  // Names that differ only in - and _ share a namespace and would be rejected.
  const namespaces = Object.keys(servers).map((n) => parser.mcpNamespace(n));
  assert.equal(new Set(namespaces).size, namespaces.length, "namespace clash");
});

test("no legacy adapter fields anywhere: auth/bearerToken/directTools/redirectUri gone", () => {
  const servers = readJson("mcp.json").mcpServers;
  for (const [name, cfg] of Object.entries(servers)) {
    for (const field of ["auth", "bearerToken", "directTools"]) {
      assert.ok(!(field in (cfg as object)), `${name}.${field} is adapter-only`);
    }
    const oauth = (cfg as { oauth?: Record<string, unknown> }).oauth;
    if (oauth) assert.ok(!("redirectUri" in oauth), `${name}.oauth.redirectUri is now callbackUrl`);
  }
});

test("slack-workos: clientId and exact callbackUrl; direct tools preserved from the adapter config", () => {
  const slack = readJson("mcp.json").mcpServers["slack-workos"];
  assert.equal(slack.oauth.clientId, "1601185624273.8899143856786");
  assert.equal(slack.oauth.callbackUrl, "http://localhost:3118/callback");
  const legacy = readJson("fitch-mcp-adapter/mcp.json").mcpServers["slack-workos"];
  assert.deepEqual(Object.keys(slack.toolExposure).sort(), [...legacy.directTools].sort());
  assert.ok(Object.values(slack.toolExposure).every((v) => v === "direct"));
});

test("horizon/alto: codemode exposure only — no toolExposure, no published internal tool inventory", () => {
  const servers = readJson("mcp.json").mcpServers;
  for (const name of ["horizon", "alto"]) {
    assert.equal(servers[name].exposure, "codemode", name);
    assert.ok(!("toolExposure" in servers[name]), `${name} must not publish a direct-tool inventory`);
  }
});

test("github: Authorization is the documented whole-value command header (never executed here)", () => {
  const github = readJson("mcp.json").mcpServers.github;
  assert.deepEqual(github.headers, { Authorization: "!echo Bearer $(gh auth token)" });
});

test("settings.json: adapter package removed, defaultTools additively enables codemode", () => {
  const now = readJson("settings.json");
  assert.deepEqual(now.defaultTools, ["+codemode"]);
  assert.ok(
    !now.packages.some((p: unknown) => typeof p === "string" && p.includes("pi-mcp-adapter")),
    "pi-mcp-adapter pin must be gone from packages",
  );
});

test("agent/fitch-mcp-adapter/mcp.json retained for rollback: exactly the nine legacy servers", () => {
  const legacy = readJson("fitch-mcp-adapter/mcp.json").mcpServers;
  assert.deepEqual(Object.keys(legacy).sort(), [...LEGACY_SERVERS].sort());
});

test("gitignore policy: agent/mcp-auth.json stays ignored; agent/mcp.json is trackable", () => {
  const repo = fixtureRepo();
  // check-ignore exits 0 (ignored) / 1 (not); the fixture's git() helper throws on 1.
  const run = (rel: string) => {
    try {
      execFileSync("git", ["-C", repo, "check-ignore", "-q", rel]);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(run("agent/mcp-auth.json"), true, "native token file must stay default-deny ignored");
  assert.equal(run("agent/mcp.json"), false, "native config must be trackable");
  assert.equal(run("agent/fitch-mcp-adapter/mcp.json"), false, "rollback config stays tracked");
});

test("cloak.json: the REAL installed pi-cloak masks fake native OAuth secrets in mcp-auth.json", async () => {
  type CloakModule = {
    loadState: (configPath: string) => unknown;
    cloakText: (text: string, path: string, cwd: string, state: unknown) => string;
  };
  // dist/index.js: node refuses type-stripping for .ts under node_modules.
  const cloakPath = join(homedir(), ".pi/agent/npm/node_modules/@nicknisi/pi-cloak/dist/index.js");
  const cloak = (await import(pathToFileURL(cloakPath).href)) as CloakModule;
  const state = cloak.loadState(join(AGENT, "cloak.json"));

  // Shape mirrors what installed pi-mcp persists per server URL
  // (oauth/provider.js: tokens, clientInformation incl. registration_access_token, codeVerifier).
  const fake = JSON.stringify(
    {
      "https://example.invalid/mcp": {
        tokens: {
          access_token: "SENTINEL-FAKE-access-9f8d",
          refresh_token: "SENTINEL-FAKE-refresh-2b7a",
          id_token: "SENTINEL-FAKE-id-41c2",
          token_type: "Bearer",
        },
        clientInformation: {
          client_id: "public-client-id",
          client_secret: "SENTINEL-FAKE-secret-77aa",
          registration_access_token: "SENTINEL-FAKE-registration-5e21",
        },
        codeVerifier: "SENTINEL-FAKE-pkce-3c9d",
      },
    },
    null,
    2,
  );
  const out = cloak.cloakText(fake, join(homedir(), ".pi/agent/mcp-auth.json"), REPO, state);
  assert.ok(!out.includes("SENTINEL-FAKE"), `secrets must be masked:\n${out}`);
  for (const key of ["access_token", "refresh_token", "id_token", "client_secret", "registration_access_token", "codeVerifier"]) {
    assert.ok(out.includes(`"${key}"`), `key ${key} stays readable`);
  }
  assert.ok(out.includes("public-client-id"), "client_id is public and stays readable");

  // A value containing an escaped quote must be masked through its closing quote.
  const escaped = '{"https://example.invalid/mcp":{"clientInformation":{"client_secret":"prefix\\"SENTINEL-FAKE-escaped-tail"}}}';
  const outEscaped = cloak.cloakText(escaped, join(homedir(), ".pi/agent/mcp-auth.json"), REPO, state);
  assert.ok(!outEscaped.includes("SENTINEL-FAKE"), `escaped value must be fully masked:\n${outEscaped}`);
});
