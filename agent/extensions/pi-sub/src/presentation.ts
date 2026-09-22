/** Local rendering of the quota state. Labels are ours; nothing here comes from the server. */

import type { QuotaFailure } from "./http.ts";
import type { ProviderId, Quota } from "./quota.ts";

/** Everything the UI is allowed to see. Credentials and identities are deliberately absent. */
export type QuotaView = {
  provider: ProviderId;
  loading: boolean;
  quota: Quota | undefined;
  /** When the shown quota was read, used to age it. */
  quotaAt: number | undefined;
  error: QuotaFailure | undefined;
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  "openai-codex": "codex",
  "opencode-go": "opencode",
};

/** Compact footer segment; Pi keeps its own footer around it. */
export function formatStatus(view: QuotaView, now: number): string {
  const label = `sub ${PROVIDER_LABEL[view.provider]}`;

  if (view.quota) {
    const windows = view.quota.windows.map(
      (window) => `${window.kind} ${window.remainingPercent}% ${resetText(window.resetsAt, now)}`,
    );
    const stale = view.error && view.quotaAt !== undefined ? [`stale ${formatDuration(now - view.quotaAt)}`] : [];
    return [label, ...windows, ...stale].join(" | ");
  }

  if (view.error) return `${label} | ${view.error.message}`;
  return `${label} | ${view.loading ? "loading..." : "no data"}`;
}

/** Transient detail for `/sub`, shown as a notification and never persisted. */
export function formatDetail(view: QuotaView | undefined, now: number): string {
  if (view === undefined) return "pi-sub: no supported provider active";

  const lines = [`pi-sub: ${PROVIDER_LABEL[view.provider]}`];
  if (view.quota) {
    for (const window of view.quota.windows) {
      lines.push(`${window.kind}: ${window.remainingPercent}% left, ${resetText(window.resetsAt, now)}`);
    }
    if (view.quotaAt !== undefined) lines.push(`updated ${formatDuration(now - view.quotaAt)} ago`);
  } else if (!view.error && !view.loading) {
    lines.push("no data yet");
  }

  if (view.error) lines.push(`last attempt: ${view.error.message}`);
  if (view.loading) lines.push("refreshing...");
  return lines.join("\n");
}

/** Countdown recomputed from the reset timestamp; no timer animates it. */
function resetText(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return "reset unknown";
  return resetsAt > now ? `in ${formatDuration(resetsAt - now)}` : "resetting now";
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds % 60}s`;
}
