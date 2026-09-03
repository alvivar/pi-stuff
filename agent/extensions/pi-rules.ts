/**
 * Pi Rules — persistent prompt guidance injected into every LLM turn.
 *
 * Use --append-system-prompt for static, always-on instructions.
 * Use /rules for dynamic, branch-local guidance.
 *
 * /rules <text>   → set rules
 * /rules @<file>  → set rules from file
 * /rules          → show current rules
 * /rules clear    → clear rules
 *
 * Note: "clear" is a reserved literal — rules consisting solely of that word cannot be set.
 * Note: @ paths are used verbatim after trim; quotes are not stripped.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_PREVIEW = 280;

/** Payload persisted per `rules` entry; `null` marks an explicit clear. */
type RulesData = { text: string | null };

export default function (pi: ExtensionAPI) {
  let rulesText: string | null = null;

  function restoreRules(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getBranch();
    rulesText = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === "rules") {
        rulesText = (entry.data as RulesData | undefined)?.text ?? null;
        break;
      }
    }
  }

  function updateWidget(ctx: ExtensionContext) {
    if (rulesText) {
      const preview = rulesText.split("\n")[0].slice(0, MAX_PREVIEW);
      const text =
        rulesText.length > MAX_PREVIEW || rulesText.includes("\n")
          ? preview + "..."
          : rulesText;
      ctx.ui.setWidget("pi-rules", [ctx.ui.theme.fg("dim", `⚙ ${text}`)]);
    } else {
      ctx.ui.setWidget("pi-rules", undefined);
    }
  }

  /** Rules are branch-local, so re-read them whenever the active branch changes. */
  function syncRules(_event: unknown, ctx: ExtensionContext) {
    restoreRules(ctx);
    updateWidget(ctx);
  }

  pi.on("session_start", syncRules);
  pi.on("session_tree", syncRules);

  pi.on("before_agent_start", (event) => {
    if (!rulesText) return;
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Session Rules\nFollow this guidance for the current session.\n\n${rulesText}`,
    };
  });

  pi.registerCommand("rules", {
    description:
      "Prompt guidance for every turn (current branch). Use /rules clear to remove.",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "clear", label: "clear", description: "Clear current rules" },
      ];
      const filtered = items.filter((i) =>
        i.value.startsWith(prefix.trimStart()),
      );
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      if (!trimmed) {
        if (rulesText) {
          ctx.ui.notify(`⚙ ${rulesText}`, "info");
        } else {
          ctx.ui.notify(
            "No rules set. Use /rules <text> to add branch-local prompt guidance.\n\nNote: rules are guidance appended to the prompt each turn, the model is not enforced to follow them.",
            "info",
          );
        }
        return;
      }

      if (trimmed === "clear") {
        rulesText = null;
        pi.appendEntry("rules", { text: null });
        updateWidget(ctx);
        ctx.ui.notify("Rules cleared", "info");
        return;
      }

      if (trimmed.startsWith("@")) {
        const filePath = trimmed.slice(1);
        const resolved = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(ctx.cwd, filePath);
        let text: string;
        try {
          text = fs.readFileSync(resolved, "utf-8").trim();
        } catch {
          ctx.ui.notify(`Could not read: ${resolved}`, "error");
          return;
        }
        if (!text) {
          ctx.ui.notify(`File is empty: ${resolved}`, "warning");
          return;
        }
        rulesText = text;
        pi.appendEntry("rules", { text: rulesText });
        updateWidget(ctx);
        ctx.ui.notify(
          `Rules loaded from ${resolved} (${rulesText.length} chars)`,
          "info",
        );
        return;
      }

      rulesText = trimmed;
      pi.appendEntry("rules", { text: rulesText });
      updateWidget(ctx);
      ctx.ui.notify(`Rules set (${rulesText.length} chars)`, "info");
    },
  });
}
