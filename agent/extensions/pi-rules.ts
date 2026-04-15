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

  type RulesEntry = { type: string; customType?: string; data?: { text?: string | null } };

  function restoreRules(ctx: { sessionManager: { getBranch(): RulesEntry[] } }) {
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

  function updateStatus(ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) {
    ctx.ui.setStatus("pi-rules", rulesText ? "rules" : undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    restoreRules(ctx);
    updateStatus(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreRules(ctx);
    updateStatus(ctx);
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
    description: "Set, show, or clear session rules injected into every turn",
    handler: (args, ctx) => {
      const trimmed = (args ?? "").trim();

      if (!trimmed) {
        if (rulesText) {
          ctx.ui.notify(`Current rules:\n${rulesText}`, "info");
        } else {
          ctx.ui.notify("No session rules set", "info");
        }
        return;
      }

      if (trimmed === "clear") {
        rulesText = null;
        pi.appendEntry("rules", { text: null });
        updateStatus(ctx);
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
        updateStatus(ctx);
        ctx.ui.notify(
          `Rules loaded from ${resolved} (${rulesText.length} chars)`,
          "info",
        );
        return;
      }

      rulesText = trimmed;
      pi.appendEntry("rules", { text: rulesText });
      updateStatus(ctx);
      ctx.ui.notify(`Rules set (${rulesText.length} chars)`, "info");
    },
  });
}
