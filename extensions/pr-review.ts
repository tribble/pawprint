// pr-review — coordinator-side pi extension.
//
// Registers a single tool, open_pr_review, that shells out to `pr-review --nvim`
// (bash, ~/.local/bin) to open a new herdr tab in the current workspace running
// Neovim + octo.nvim, so the human can read their own PR's diff and reviewer
// comments; the human's line notes route back to this session as intercom.
// All real logic (repo/PR resolution, herdr calls) lives in
// pr-review; this file stays thin and only computes this session's own
// intercom ID, passing it via the --coordinator argv flag. NOTE: pi.exec()
// (dist/core/exec.d.ts ExecOptions) only supports signal|timeout|cwd — an
// `env` option is silently dropped and the child inherits pi's environment, so
// the coordinator must be handed over via argv, not PR_REVIEW_COORDINATOR.
//
// Load-safety: this file ships in the pawprint package (global) and
// loads in every pi session. The factory below has no top-level side effects
// and does no I/O outside of execute().
//
// See /Users/pantera/work/pi/pr-review/README.md for the full architecture.

import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This session's pi-intercom ID: the one address that survives a rename (names
// are display only; routing by them broke when a coordinator renamed itself).
// Same formula pi-subagents registers with — src/pi-intercom/index.ts L1284 at
// the pinned 84614b3: `pi-` + sha256(ctx.sessionManager.getSessionId()).hex[0:32].
// Duplicated verbatim in herdr-fleet.ts: one line beats a shared module.
const intercomId = (sessionId: string) => `pi-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;

interface PrReviewResult {
  ok?: boolean;
  surface?: string;
  tab_id?: string;
  pane_id?: string;
  repo?: string;
  pr?: number;
  coordinator?: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "open_pr_review",
    label: "Open PR Review",
    description:
      "Open a GitHub PR's diff in the octo.nvim diff viewer (Neovim) in a new herdr tab in the " +
      "current workspace (`pr-review --nvim`; the VS Code path is `pr-review <N>`). For reviewing " +
      "the user's OWN PRs (typically ones this session opened): the human reads the diff and " +
      "reviewer comments there and sends line/range-scoped notes back to this session over " +
      "pi-intercom as steer messages while they review -- this tool's result only confirms the " +
      "tab opened.",
    promptSnippet:
      "Open one of the user's own GitHub PRs for review in a new herdr tab (Neovim/octo.nvim)",
    promptGuidelines: [
      "Use open_pr_review to hand one of the user's own PRs to them for review in a herdr tab; their line notes arrive later as separate intercom steer messages, not in this tool's result.",
      "Use open_pr_review only when running inside herdr (HERDR_ENV=1); it shells out to `pr-review --nvim`, which fails fast with guidance otherwise.",
    ],
    parameters: Type.Object({
      pr: Type.String({
        description:
          'PR reference: "owner/repo#123", a github.com PR URL, or a bare PR number (looked up in the review queue, then in the repos of ~/.pi/agent/configs/ws.json; ambiguous or unknown -> error).',
      }),
      focus: Type.Optional(
        Type.Boolean({
          description: "Focus the new herdr tab (default: true). Pass false to open it in the background.",
        }),
      ),
      coordinator: Type.Optional(
        Type.String({
          description:
            "Override the pi-intercom session (ID, or the exact name of a live session) that review notes are sent to. Defaults to this session's own intercom ID.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // An explicit tool param wins; otherwise this session's own intercom ID
      // (every pi session has one, named or not). pr-note resolves a name in
      // the param to an ID at send time.
      const coordinator = params.coordinator?.trim() || intercomId(ctx.sessionManager.getSessionId());

      // argv, not env: pi.exec() cannot forward env vars (see header note).
      const args: string[] = ["--nvim", params.pr, "--coordinator", coordinator];
      if (params.focus === false) {
        args.push("--no-focus");
      }

      const result = await pi.exec("pr-review", args, { signal });

      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || "").trim() || `exit code ${result.code}`;
        throw new Error(`pr-review --nvim failed: ${detail}`);
      }

      let parsed: PrReviewResult = {};
      const stdout = result.stdout.trim();
      try {
        parsed = stdout ? (JSON.parse(stdout) as PrReviewResult) : {};
      } catch {
        // Non-JSON stdout is unexpected but not fatal; surface the raw output below.
      }

      const resolvedCoordinator = parsed.coordinator ?? coordinator;
      const text = parsed.pane_id
        ? `Opened PR review for ${parsed.repo ?? "?"}#${parsed.pr ?? "?"} in herdr tab ${parsed.tab_id ?? "?"} (pane ${parsed.pane_id}). ` +
          `Review notes will arrive as pi-intercom steer messages from coordinator "${resolvedCoordinator}" as the human comments.`
        : `pr-review --nvim ran successfully but returned no pane id. Raw output: ${stdout || "(empty)"}`;

      return {
        content: [{ type: "text", text }],
        details: {
          tabId: parsed.tab_id,
          paneId: parsed.pane_id,
          repo: parsed.repo,
          pr: parsed.pr,
          coordinator: resolvedCoordinator,
        },
      };
    },
  });
}
