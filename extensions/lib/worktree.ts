import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface Worktree {
  cwd: string;
  root: string;
  key: string;
  common: string;
  branch: string | null;
  commit: string;
}

export interface WriterClaim {
  version: 1;
  ownerSessionId: string;
  ownerSessionFile: string;
  childSessionId: string;
  launchId: string;
  worktreeKey: string;
  cwd: string;
  branch: string | null;
  baseCommit: string;
}

export async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const result = await pi.exec("git", ["-C", cwd, ...args], { signal });
  if (result.code !== 0 || result.killed) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export async function worktreeIdentity(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<Worktree> {
  if (await gitOutput(pi, cwd, ["rev-parse", "--is-inside-work-tree"], signal) !== "true") throw new Error(`Not a Git working tree: ${cwd}`);
  const root = realpathSync.native(await gitOutput(pi, cwd, ["rev-parse", "--show-toplevel"], signal));
  const key = realpathSync.native(await gitOutput(pi, cwd, ["rev-parse", "--absolute-git-dir"], signal));
  const common = realpathSync.native(await gitOutput(pi, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal));
  const branch = await gitOutput(pi, cwd, ["branch", "--show-current"], signal);
  const commit = await gitOutput(pi, cwd, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
  return { cwd, root, key, common, branch: branch || null, commit };
}

export function worktreeDestination(source: Worktree, name: string, launchId: string) {
  const branch = `${name}-${launchId}`;
  return { branch, cwd: join(dirname(source.root), `${basename(source.root)}-${branch}`) };
}

export async function createWorktree(pi: ExtensionAPI, source: Worktree, destination: { cwd: string; branch: string }, commit: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  mkdirSync(destination.cwd); // Exclusive reservation; Git accepts our empty directory.
  await gitOutput(pi, source.cwd, ["worktree", "add", "-b", destination.branch, destination.cwd, commit], signal);
  const tree = await worktreeIdentity(pi, destination.cwd, signal);
  if (tree.branch !== destination.branch || tree.commit !== commit) throw new Error("Created worktree does not match the requested branch/base; keep and inspect it");
  return tree;
}

export const writerClaimPath = (worktree: Worktree) => join(worktree.key, "pawprint-writer.json");

export function readWriterClaim(worktree: Worktree): { claim: WriterClaim; hash: string } | null {
  const path = writerClaimPath(worktree);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe writer claim; keep and inspect ${path}`);
  const text = readFileSync(path, "utf8");
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Malformed writer claim JSON; keep and inspect ${path}`); }
  if (!data || typeof data !== "object") throw new Error(`Invalid writer claim; keep and inspect ${path}`);
  const claim = data as Record<string, unknown>;
  if (claim.version !== 1 || claim.worktreeKey !== worktree.key ||
      !["ownerSessionId", "ownerSessionFile", "childSessionId", "launchId", "cwd", "baseCommit"].every((key) => typeof claim[key] === "string" && claim[key]) ||
      !(claim.branch === null || typeof claim.branch === "string")) {
    throw new Error(`Invalid writer claim; keep and inspect ${path}`);
  }
  return { claim: claim as unknown as WriterClaim, hash: createHash("sha256").update(text).digest("hex") };
}

export function claimWriter(worktree: Worktree, claim: WriterClaim): string {
  const fd = openSync(writerClaimPath(worktree), "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(claim)}\n`); }
  finally { closeSync(fd); }
  const stored = readWriterClaim(worktree);
  if (!stored) throw new Error(`Writer claim disappeared; inspect ${writerClaimPath(worktree)}`);
  return stored.hash;
}

// The same cross-process gate covers admission and explicit release. No stale reclaim.
export async function withWriterOperation<T>(worktree: Worktree, operation: () => Promise<T>): Promise<T> {
  const path = join(worktree.key, "pawprint-writer.lock");
  const token = randomUUID();
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`Writer admission/release is in flight or uncertain. Keep and inspect ${path}; no automatic reclaim.`);
    }
    throw error;
  }
  let outcome: { result: T } | { error: unknown };
  try {
    writeFileSync(fd, token);
    outcome = { result: await operation() };
  } catch (error) { outcome = { error }; }
  finally { closeSync(fd); }
  if (readFileSync(path, "utf8") !== token) throw new Error(`Writer lock changed; keep and inspect ${path}`);
  unlinkSync(path);
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

export function removeWriterClaim(worktree: Worktree, expectedHash: string) {
  if (readWriterClaim(worktree)?.hash !== expectedHash) throw new Error("Writer claim changed during release; keep it and reconcile ownership");
  unlinkSync(writerClaimPath(worktree));
}
