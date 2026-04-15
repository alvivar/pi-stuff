/**
 * Pi Rules — persistent session rules injected into every LLM turn.
 *
 * /rules <text>   → set rules
 * /rules @<file>  → set rules from file
 * /rules          → show current rules
 * /rules clear    → clear rules
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  let rulesText: string | null = null;

  type RulesEntry = {
    type: string;
    customType?: string;
    data?: { text?: string | null };
  };

  function restoreRules(ctx: {
    sessionManager: { getBranch(): RulesEntry[] };
  }) {
    const entries = ctx.sessionManager.getBranch();
    rulesText = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === "rules") {
        rulesText = entry.data?.text ?? null;
        break;
      }
    }
  }

  function updateWidget(ctx: {
    ui: {
      theme: { fg(style: string, text: string): string };
      setWidget(
        key: string,
        content: string[] | undefined,
        options?: { placement?: string },
      ): void;
    };
  }) {
    if (rulesText) {
      const preview = rulesText.split("\n")[0].slice(0, 280);
      const text =
        rulesText.length > 280 || rulesText.includes("\n")
          ? preview + "..."
          : rulesText;
      ctx.ui.setWidget("pi-rules", [ctx.ui.theme.fg("dim", `⚙ ${text}`)]);
    } else {
      ctx.ui.setWidget("pi-rules", undefined);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    restoreRules(ctx);
    updateWidget(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreRules(ctx);
    updateWidget(ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (!rulesText) return;
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Session Rules\nFollow these rules for this session:\n\n${rulesText}`,
    };
  });

  pi.registerCommand("rules", {
    description:
      "Prompt guidance for every turn (current branch). Use /rules clear to remove.",
    handler: (args, ctx) => {
      const trimmed = (args ?? "").trim();

      if (!trimmed) {
        if (rulesText) {
          ctx.ui.notify(`⚙ ${rulesText}`, "info");
        } else {
          ctx.ui.notify(
            "No branch rules set. Use /rules <text> to add branch-local prompt guidance.\n\nNote: rules are guidance appended to the prompt each turn, the model is not enforced to follow them.",
            "info",
          );
        }
        return;
      }

      if (trimmed === "clear") {
        rulesText = null;
        pi.appendEntry("rules", { text: null });
        updateWidget(ctx);
        ctx.ui.notify("Session rules cleared", "info");
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
          ctx.ui.notify(`Rules file is empty: ${resolved}`, "warning");
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
