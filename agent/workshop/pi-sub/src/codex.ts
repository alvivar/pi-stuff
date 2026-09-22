/**
 * Codex (`openai-codex`) quota interpretation.
 *
 * Response shape knowledge (`rate_limit.primary_window` / `secondary_window`
 * with `used_percent` and `reset_at` in Unix seconds) comes from the audited
 * MIT-licensed `@bacnh85/pi-sub`; the code here is written from scratch.
 */

import {
  asRecord,
  remainingFromUsedPercent,
  resetFromUnixSeconds,
  type Quota,
  type QuotaWindow,
  type WindowKind,
} from "./quota.ts";

/** Known rate limit windows, in presentation order. */
const WINDOWS: ReadonlyArray<readonly [field: string, kind: WindowKind]> = [
  ["primary_window", "5h"],
  ["secondary_window", "weekly"],
];

/** Quota from a Codex usage response, or undefined when nothing is usable. */
export function parseCodexQuota(body: unknown): Quota | undefined {
  const rateLimit = asRecord(asRecord(body)?.rate_limit);
  if (!rateLimit) return undefined;

  const windows: QuotaWindow[] = [];
  for (const [field, kind] of WINDOWS) {
    const window = asRecord(rateLimit[field]);
    if (!window) continue;

    const remainingPercent = remainingFromUsedPercent(window.used_percent);
    if (remainingPercent === undefined) continue;

    windows.push({ kind, remainingPercent, resetsAt: resetFromUnixSeconds(window.reset_at) });
  }

  return windows.length > 0 ? { provider: "openai-codex", windows } : undefined;
}
