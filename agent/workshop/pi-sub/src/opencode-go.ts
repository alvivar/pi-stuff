/**
 * OpenCode Go (`opencode-go`) quota interpretation.
 *
 * Response shape knowledge (`usage.rolling` / `weekly` / `monthly` with
 * `percent` used and `resetsAt` as an ISO 8601 date) comes from the audited
 * MIT-licensed `@bacnh85/pi-sub`; the code here is written from scratch.
 */

import {
  asRecord,
  remainingFromUsedPercent,
  resetFromIsoDate,
  type Quota,
  type QuotaWindow,
  type WindowKind,
} from "./quota.ts";

/** Known usage windows, in presentation order. */
const WINDOWS: ReadonlyArray<readonly [field: string, kind: WindowKind]> = [
  ["rolling", "rolling"],
  ["weekly", "weekly"],
  ["monthly", "monthly"],
];

/** Quota from an OpenCode Go usage response, or undefined when nothing is usable. */
export function parseOpencodeGoQuota(body: unknown): Quota | undefined {
  const usage = asRecord(asRecord(body)?.usage);
  if (!usage) return undefined;

  const windows: QuotaWindow[] = [];
  for (const [field, kind] of WINDOWS) {
    const window = asRecord(usage[field]);
    if (!window) continue;

    const remainingPercent = remainingFromUsedPercent(window.percent);
    if (remainingPercent === undefined) continue;

    windows.push({ kind, remainingPercent, resetsAt: resetFromIsoDate(window.resetsAt) });
  }

  return windows.length > 0 ? { provider: "opencode-go", windows } : undefined;
}
