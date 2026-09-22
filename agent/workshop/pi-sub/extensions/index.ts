/**
 * pi-sub — shows the remaining quota of the active provider in the TUI footer.
 * The factory only registers handlers: requests and timers start with a TUI session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatDetail, formatDuration, formatStatus } from "../src/presentation.ts";
import { createQuotaQuery, createQuotaRuntime, supportedProvider, type QuotaRuntime } from "../src/runtime.ts";

const STATUS_KEY = "pi-sub";

export default function (pi: ExtensionAPI): void {
  let runtime: QuotaRuntime | undefined;

  pi.on("session_start", (_event, ctx) => {
    runtime?.stop(); // A restart without shutdown would otherwise leave a timer behind.
    runtime = undefined;
    if (ctx.mode !== "tui") return;

    runtime = createQuotaRuntime({
      query: createQuotaQuery(ctx.modelRegistry),
      onView: (view) => ctx.ui.setStatus(STATUS_KEY, view ? formatStatus(view, Date.now()) : undefined),
    });
    runtime.activate(supportedProvider(ctx.model?.provider));
  });

  pi.on("model_select", (event, _ctx) => {
    runtime?.activate(supportedProvider(event.model.provider));
  });

  pi.on("session_shutdown", () => {
    runtime?.stop();
    runtime = undefined;
  });

  pi.registerCommand("sub", {
    description: "Show the provider quota (/sub refresh to update)",
    handler: async (args, ctx) => {
      // TUI-only surface: outside it there is no runtime and no UI of ours at all.
      if (ctx.mode !== "tui" || runtime === undefined) return;

      const command = args.trim();
      if (command === "") {
        ctx.ui.notify(formatDetail(runtime.view(), Date.now()), "info");
        return;
      }

      ctx.ui.notify(command === "refresh" ? refreshMessage(runtime) : "pi-sub: usage is /sub or /sub refresh", "info");
    },
  });
}

function refreshMessage(runtime: QuotaRuntime): string {
  const outcome = runtime.refresh();
  if (outcome.started) return "pi-sub: refreshing...";

  if (outcome.reason === "wait") return `pi-sub: wait ${formatDuration(outcome.waitMs)} before refreshing`;
  return outcome.reason === "busy" ? "pi-sub: already refreshing" : "pi-sub: no supported provider active";
}
