// pr-review — coordinator-side pi extension.
//
// Registers a single tool, open_pr_review, that shells out to pr-review-open
// (bash, ~/.local/bin) to split a herdr pane running Neovim + octo.nvim for an
// interactive human PR review. All real logic (repo/PR resolution, herdr calls,
// further coordinator resolution fallbacks) lives in pr-review-open; this file
// stays thin and only resolves this session's own intercom identity, passing it
// via the --coordinator argv flag. NOTE: pi.exec() (dist/core/exec.d.ts
// ExecOptions) only supports signal|timeout|cwd — an `env` option is silently
// dropped and the child inherits pi's environment, so the coordinator must be
// handed over via argv, not PR_REVIEW_COORDINATOR.
//
// Load-safety: this file is installed globally (~/.pi/agent/extensions/) and
// loads in every pi session. The factory below has no top-level side effects
// and does no I/O outside of execute().
//
// See /Users/pantera/work/pi/pr-review/README.md for the full architecture.

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// For an unnamed pi session, pi.getSessionName() returns undefined, but the
// pi-intercom broker still shows a derived presence alias. Mirror
// resolveIntercomPresenceName / buildPresenceIdentity from pi-subagents
// (src/pi-intercom/index.ts, ~L432-443): the registered name is
// $PI_SUBAGENT_INTERCOM_SESSION_NAME if set, else the session name, else
// `subagent-chat-<sessionId[0:8]>` (any "session-" prefix stripped first).
function deriveIntercomAlias(ctx: ExtensionContext): string | undefined {
  const envName = process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME?.trim();
  if (envName) {
    return envName;
  }
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) {
    return undefined;
  }
  const normalized = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `subagent-chat-${normalized.slice(0, 8)}`;
}

interface PrReviewOpenResult {
  ok?: boolean;
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
      "Open an interactive GitHub PR review layout in a herdr split pane running Neovim " +
      "with octo.nvim (full GitHub review support). The human reviews the diff there and " +
      "line/range-scoped comments are sent back to this session over pi-intercom as steer " +
      "messages while they review -- this tool's result only confirms the pane opened.",
    promptSnippet:
      "Open an interactive human PR review (herdr pane + Neovim/octo.nvim) for a GitHub PR",
    promptGuidelines: [
      "Use open_pr_review to hand a PR to the human for interactive review; their line comments arrive later as separate intercom steer messages, not in this tool's result.",
      "Use open_pr_review only when running inside herdr (HERDR_ENV=1); it shells out to pr-review-open, which fails fast with guidance otherwise.",
    ],
    parameters: Type.Object({
      pr: Type.String({
        description:
          'PR reference: "owner/repo#123", a bare PR number (repo resolved from the current working directory via gh), or a github.com PR URL.',
      }),
      focus: Type.Optional(
        Type.Boolean({
          description: "Focus the new herdr pane instead of opening it in the background (default: false).",
        }),
      ),
      coordinator: Type.Optional(
        Type.String({
          description:
            "Override the pi-intercom session (name or id) that review notes are sent to. Defaults to this session's own intercom name.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Resolution chain: explicit tool param > this session's name >
      // derived intercom alias for unnamed sessions (see deriveIntercomAlias).
      // If all fail, no --coordinator is passed and pr-review-open falls back
      // to its config-file chain, erroring with setup guidance if that fails.
      const coordinator =
        params.coordinator?.trim() || pi.getSessionName()?.trim() || deriveIntercomAlias(ctx) || undefined;

      // --require-coordinator keeps the agent path strict: if resolution and
      // pr-review-open's own fallback chain all fail, it exits non-zero with
      // setup guidance instead of opening a pane whose notes go nowhere.
      const args: string[] = ["--require-coordinator"];
      if (coordinator) {
        // argv, not env: pi.exec() cannot forward env vars (see header note).
        args.push("--coordinator", coordinator);
      }
      if (params.focus) {
        args.push("--focus");
      }
      args.push(params.pr);

      const result = await pi.exec("pr-review-open", args, { signal });

      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || "").trim() || `exit code ${result.code}`;
        throw new Error(`pr-review-open failed: ${detail}`);
      }

      let parsed: PrReviewOpenResult = {};
      const stdout = result.stdout.trim();
      try {
        parsed = stdout ? (JSON.parse(stdout) as PrReviewOpenResult) : {};
      } catch {
        // Non-JSON stdout is unexpected but not fatal; surface the raw output below.
      }

      const resolvedCoordinator = parsed.coordinator ?? coordinator ?? "(resolved by pr-review-open)";
      const text = parsed.pane_id
        ? `Opened PR review for ${parsed.repo ?? "?"}#${parsed.pr ?? "?"} in herdr pane ${parsed.pane_id}. ` +
          `Review notes will arrive as pi-intercom steer messages from coordinator "${resolvedCoordinator}" as the human comments.`
        : `pr-review-open ran successfully but returned no pane id. Raw output: ${stdout || "(empty)"}`;

      return {
        content: [{ type: "text", text }],
        details: {
          paneId: parsed.pane_id,
          repo: parsed.repo,
          pr: parsed.pr,
          coordinator: resolvedCoordinator,
        },
      };
    },
  });
}
