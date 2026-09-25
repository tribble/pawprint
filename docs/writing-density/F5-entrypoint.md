[Context: you are the agent maintaining spikes/api-services-barrel-design.md in the workos monorepo. A coordinator agent just relayed the owner's decision to you. Replace the current "one index.ts per top-level dir" wording in the doc's mechanics bullets with the rule below. Output only the replacement bullet(s) for the doc.]

Owner-approved reframe of the entry-point rule — replace the "one index.ts per top-level dir" wording. No numeric heuristics anywhere.

The rule, one sentence: a directory is an entry point iff it has an index.ts; put one where a consumer of anything inside would want everything inside.

Mechanics: `"./*": "./lib/*/index.js"` — Node's `*` spans `/`, so any directory at any depth with an index.ts resolves (`…/foo`, `…/foo/bar`), while bare file paths never do (verified). Granularity is decided by where index.ts files exist, not by config; changing a split later = add or delete an index.ts. ~310 index.ts files to create; 7 already exist. `export *` is fine in them.
