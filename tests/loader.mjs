// ESM loader hook: redirect pi's runtime packages to zero-dependency stubs.
// (NODE_PATH is CJS-only; this is the ESM-correct way.) Extensions whose
// imports from these packages are type-only never touch the stubs at all —
// type stripping erases those imports before resolution.
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stubs = {
  "@earendil-works/pi-coding-agent": join(here, "stubs", "pi-coding-agent.mjs"),
  "@earendil-works/pi-tui": join(here, "stubs", "pi-tui.mjs"),
};

export async function resolve(specifier, context, next) {
  if (stubs[specifier]) {
    return { url: pathToFileURL(stubs[specifier]).href, shortCircuit: true };
  }
  return next(specifier, context);
}
