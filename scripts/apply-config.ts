// apply-config.ts — field-aware application of one source config file onto a
// live one, for the two files both pi and pawprint write: settings.json and
// mcp.json. Source values are intentional and win per key; live-only keys at
// any depth survive; arrays replace wholesale. Runtime-owned fields are never
// applied from source. Writes match pi's own format and happen only on change.
//
// Guards, all before any read or write: no symlinked path component on either
// side (the live dir holds credentials a planted link could point at), no
// hardlinked target (nlink > 1 — writing it would clobber the linked file),
// no non-regular destination (a directory where the file belongs). Malformed
// or non-object JSON on either side is refused, never overwritten; so is an
// object boundary mismatched between source and live (e.g. a live mcpServers
// array — pi's own MCP writer refuses that shape too): apply never silently
// discards a live value to make the source fit. Every failure is one concise
// line, never a Node stack.
//
// A '..' component in either path is refused at argv, before resolve() could
// erase it: collapsed lexically it can name a different directory than the
// filesystem reaches through a symlinked component, and guard/write would
// diverge. After that refusal, resolve() is purely lexical cleanup (relative
// → cwd, /., //, trailing /) that never crosses a symlink — so the guarded
// path and the read/written path are one spelling.
//
// Usage: node scripts/apply-config.ts [--check] (settings|mcp) <source> <target>
//        node scripts/apply-config.ts --resolve-pi
//   --check: read-only — exit 0 ("ok:") when applying would leave the target's
//   bytes unchanged, exit 1 ("drift:") otherwise. Never creates or locks a file.
//   settings.json writes go through pi's own FileSettingsStorage (lock +
//   read-modify-write + skip-when-unchanged); the package resolves via
//   PAWPRINT_PI_PKG, else mise, else npm -g, else a PATH-installed pi — and
//   only when a write is actually needed. mcp.json writes take no lock (pi's
//   own mcp writer takes none), but every merged source-managed server entry
//   is validated with pi's native validateMcpServerConfig first: a merge pi
//   itself would reject (e.g. a source oauth.callbackUrl meeting a live
//   oauth.callbackPort on another port) is refused with the conflict named
//   and the live bytes kept — in apply and --check alike.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

type Json = Record<string, unknown>;

/** Fields pi owns at runtime; a source value for one is never applied. */
const RUNTIME_OWNED = new Set(["lastChangelogVersion", "deviceId", "trackingId"]);

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function lstatOpt(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return undefined; // absent (or unreadable — the read/write will fail concisely)
  }
}

function realpathOpt(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Deep merge: source wins per leaf; plain objects recurse; arrays and scalars
 * replace. A plain object on one side facing a non-object on the other is a
 * malformed boundary — refuse rather than silently discard the live value.
 */
function merge(live: unknown, src: unknown, path: string, dstPath: string): unknown {
  if (isObj(src)) {
    if (live !== undefined && !isObj(live))
      throw new Error(`live ${path} is not an object but the source has one — not discarding it; fix by hand: ${dstPath}`);
    const out: Json = { ...(isObj(live) ? live : {}) };
    for (const [k, v] of Object.entries(src)) out[k] = merge(out[k], v, path ? `${path}.${k}` : k, dstPath);
    return out;
  }
  if (isObj(live))
    throw new Error(`live ${path} is an object but the source value is not — not discarding it; fix by hand: ${dstPath}`);
  return structuredClone(src);
}

function fail(msg: string): never {
  console.error(`apply-config: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);

// --resolve-pi: preflight for setup.sh. Resolve pi's installed package and
// verify every module/export the apply needs (native settings writer, MCP
// merge validation) BEFORE any manifest write — a missing runtime or export
// is a clear refusal, never a skipped check. Prints the package dir on
// stdout; the caller reuses it as PAWPRINT_PI_PKG for the per-file applies.
if (argv[0] === "--resolve-pi") {
  try {
    const dir = piPackageDir();
    for (const [file, api] of Object.entries({
      "settings-manager.js": "FileSettingsStorage",
      "mcp-servers.js": "validateMcpServerConfig",
    })) {
      const mod = (await import(pathToFileURL(piCoreModule(file)).href)) as Record<string, unknown>;
      if (typeof mod[api] !== "function")
        throw new Error(`pi's dist/core/${file} has no ${api} export — unsupported pi version: ${dir}`);
    }
    console.log(dir);
    process.exit(0);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

const check = argv[0] === "--check";
const [kind, srcArg, dstArg] = check ? argv.slice(1) : argv;
if ((kind !== "settings" && kind !== "mcp") || !srcArg || !dstArg) {
  console.error("usage: node scripts/apply-config.ts [--check] (settings|mcp) <source> <target> | --resolve-pi");
  process.exit(2);
}
for (const [role, p] of [["source", srcArg], ["target", dstArg]] as const) {
  if (p.split(/[\\/]/).includes(".."))
    fail(`${role} path contains a '..' component: ${p} — use an absolute path without ..`);
}
// The single safe spelling both the guard and the I/O use (see header).
const srcPath = resolve(srcArg);
const dstPath = resolve(dstArg);

/**
 * Refuse symlinked components, non-regular entries, hardlinks — before any
 * I/O. The walk covers `base` itself and every component below it. For the
 * live side `base` is the config ROOT (the target's parent, e.g. ~/.pi):
 * owner-writable, not platform layout — ancestors above the root (e.g. macOS
 * /var → /private/var) are. resolve() is lexical and never realpaths: symlink
 * evidence survives for the walk ('..' is already refused at argv).
 */
function guardPath(base: string, p: string, role: string): void {
  const absBase = resolve(base);
  const abs = resolve(p);
  if (abs !== absBase && !abs.startsWith(absBase + sep)) throw new Error(`${role} escapes its config dir: ${abs}`);
  if (lstatOpt(absBase)?.isSymbolicLink()) throw new Error(`refusing symlinked path component: ${absBase} (${role})`);
  let cur = absBase;
  for (const part of abs.slice(absBase.length).split(sep).filter(Boolean)) {
    cur = join(cur, part);
    const st = lstatOpt(cur);
    if (!st) break; // absent: nothing below exists yet
    if (st.isSymbolicLink()) throw new Error(`refusing symlinked path component: ${cur} (${role})`);
  }
  const st = lstatOpt(abs);
  if (st && !st.isFile()) throw new Error(`${role} is not a regular file: ${abs}`);
  if (st?.isFile() && st.nlink > 1) throw new Error(`${role} is hardlinked elsewhere: ${abs}`);
}

// Throws (not exit) so a failure inside pi's locked writer still runs its
// finally and releases the lock.
function parseJson(text: string, what: string, path: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON — not touching it: ${path}`);
  }
  if (!isObj(parsed)) throw new Error(`${what} is not a JSON object — not touching it: ${path}`);
  return parsed;
}

/** The mcp.json boundaries pi's own MCP writer enforces, checked on both sides. */
function checkMcpShapes(source: Json, liveText: string | undefined, srcPath: string, dstPath: string): void {
  const ss = source.mcpServers;
  if (ss !== undefined && !isObj(ss)) throw new Error(`source mcpServers is not an object: ${srcPath}`);
  if (isObj(ss))
    for (const [name, entry] of Object.entries(ss))
      if (!isObj(entry)) throw new Error(`source mcpServers.${name} is not an object: ${srcPath}`);
  if (liveText !== undefined) {
    const ls = parseJson(liveText, "live config", dstPath).mcpServers;
    if (ls !== undefined && !isObj(ls)) throw new Error(`live mcpServers is not an object — fix by hand, not touching: ${dstPath}`);
    // live server entries that the source also manages are guarded by merge's boundary rules
  }
}

/** pi's installed package dir: env override (trusted, probed at use), then mise, npm -g, or a PATH-installed pi. */
function piPackageDir(): string {
  if (process.env.PAWPRINT_PI_PKG) return process.env.PAWPRINT_PI_PKG;
  const candidates: string[] = [];
  try {
    const root = execFileSync("mise", ["where", "npm:@earendil-works/pi-coding-agent"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) candidates.push(`${root}/node_modules/@earendil-works/pi-coding-agent`);
  } catch {
    // mise absent or pi not mise-installed
  }
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (root) candidates.push(join(root, "@earendil-works", "pi-coding-agent"));
  } catch {
    // npm absent
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const real = realpathOpt(join(dir, "pi"));
    if (real && basename(real) === "cli.js" && basename(dirname(real)) === "dist") candidates.push(dirname(dirname(real)));
  }
  for (const dir of candidates) if (existsSync(join(dir, "dist", "core"))) return dir;
  throw new Error("pi's installed package not found (tried PAWPRINT_PI_PKG, mise, npm -g, PATH) — install pi first; setup.sh --all bootstraps it");
}

/** A dist/core module of pi's installed package; the module file must exist. */
function piCoreModule(file: string): string {
  const dir = piPackageDir();
  const mod = join(dir, "dist", "core", file);
  if (!existsSync(mod))
    throw new Error(
      process.env.PAWPRINT_PI_PKG
        ? `PAWPRINT_PI_PKG has no dist/core/${file}: ${dir}`
        : `pi's installed package has no dist/core/${file}: ${dir}`,
    );
  return mod;
}

type McpValidator = (name: string, config: unknown) => unknown;

/** pi's native MCP validator. A missing module or export fails loudly, never skips. */
async function mcpValidator(): Promise<McpValidator> {
  const mod = (await import(pathToFileURL(piCoreModule("mcp-servers.js")).href)) as Record<string, unknown>;
  const v = mod.validateMcpServerConfig;
  if (typeof v !== "function")
    throw new Error(`pi's dist/core/mcp-servers.js has no validateMcpServerConfig export — unsupported pi version: ${piCoreModule("mcp-servers.js")}`);
  return v as McpValidator;
}

try {
  guardPath(dirname(srcPath), srcPath, "source");
  guardPath(dirname(dirname(dstPath)), dstPath, "target"); // include the config root (e.g. ~/.pi)
  if (!lstatOpt(srcPath)?.isFile()) throw new Error(`source is not a regular file: ${srcPath}`);
  if (kind === "settings" && basename(dstPath) !== "settings.json")
    throw new Error("the settings target must be named settings.json (pi's storage writes <dir>/settings.json)");

  const source = parseJson(readFileSync(srcPath, "utf8"), "source", srcPath);
  if (kind === "settings") for (const k of RUNTIME_OWNED) delete source[k];

  const currentText = existsSync(dstPath) ? readFileSync(dstPath, "utf8") : undefined;
  if (currentText !== undefined) parseJson(currentText, "live config", dstPath); // refuse malformed live before any work
  if (kind === "mcp") checkMcpShapes(source, currentText, srcPath, dstPath);

  // mcp: pi rejects some merged configs its halves pass alone (source
  // oauth.callbackUrl vs a live oauth.callbackPort on another port). Validate
  // every source-managed server's merged entry with pi's native validator
  // before any write and in --check. Pure: the merged object is never mutated.
  const validateMcp = kind === "mcp" ? await mcpValidator() : undefined;

  /** The target's content after application (pi's own serialization per file). */
  const applied = (current: string | undefined): string => {
    const live: Json = current === undefined ? {} : parseJson(current, "live config", dstPath);
    if (kind === "mcp") {
      // pi's mcp writer (dist/extensions/mcp/config.js) rewrites the file with its
      // detected indentation and a trailing newline; there is no locked storage.
      const merged = merge(live, source, "", dstPath) as Json;
      if (validateMcp && isObj(source.mcpServers) && isObj(merged.mcpServers))
        for (const name of Object.keys(source.mcpServers)) {
          const err = validateMcp(name, merged.mcpServers[name]);
          if (typeof err === "string")
            throw new Error(
              `${err} — the merge combines live and source fields pi rejects; resolve the conflicting live/source fields, then reapply (nothing written): ${dstPath}`,
            );
        }
      const indent = (current && /^([ \t]+)\S/m.exec(current)?.[1]) || "  ";
      return `${JSON.stringify(merged, null, indent)}\n`;
    }
    return JSON.stringify(merge(live, source, "", dstPath), null, 2); // pi's settings format
  };

  const preview = applied(currentText);

  if (check) {
    console.log(`${preview === currentText ? "ok" : "drift"}: ${dstPath}`);
    process.exit(preview === currentText ? 0 : 1);
  }

  if (preview === currentText) {
    console.log(`unchanged: ${dstPath}`);
    process.exit(0);
  }

  if (kind === "settings") {
    interface Storage {
      withLock(scope: "global", fn: (current: string | undefined) => string | undefined): void;
    }
    const mod = (await import(pathToFileURL(piCoreModule("settings-manager.js")).href)) as {
      FileSettingsStorage: new (cwd: string, agentDir: string) => Storage;
    };
    const storage = new mod.FileSettingsStorage(dirname(dstPath), dirname(dstPath));
    let wrote = false;
    storage.withLock("global", (current) => {
      const next = applied(current); // merge against the fresh locked read
      if (next === current) return undefined; // native no-write when unchanged
      wrote = true;
      return next;
    });
    console.log(`${wrote ? "applied" : "unchanged"}: ${dstPath}`);
  } else {
    mkdirSync(dirname(dstPath), { recursive: true });
    writeFileSync(dstPath, preview);
    console.log(`applied: ${dstPath}`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
