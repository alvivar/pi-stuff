/** Normalized quota model and the boundary checks both providers share. */

/** Pi provider IDs this extension supports. */
export type ProviderId = "openai-codex" | "opencode-go";

/** Window kinds the supported providers report. */
export type WindowKind = "5h" | "weekly" | "rolling" | "monthly";

/** One usable window: how much quota is left and when it resets. */
export type QuotaWindow = {
  kind: WindowKind;
  /** Remaining quota as an integer percentage, 0-100. */
  remainingPercent: number;
  /** Reset instant in epoch milliseconds, or undefined when unknown. */
  resetsAt: number | undefined;
};

/** Quota of one provider. Only usable windows are listed. */
export type Quota = {
  provider: ProviderId;
  windows: QuotaWindow[];
};

/** A plain JSON object, or undefined when the value cannot be one. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Remaining percentage derived from an API "used percent" value.
 * Out-of-range percentages are clamped; anything not a finite number is unusable.
 */
export function remainingFromUsedPercent(used: unknown): number | undefined {
  if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
  return 100 - Math.min(100, Math.max(0, Math.round(used)));
}

/** Epoch milliseconds from a Unix seconds value, or undefined when unusable. */
export function resetFromUnixSeconds(seconds: unknown): number | undefined {
  if (typeof seconds !== "number") return undefined;
  const ms = Math.round(seconds * 1000);
  // Date rejects instants outside ±8.64e15 ms, so a number alone is not a date.
  return ms > 0 && Number.isFinite(new Date(ms).getTime()) ? ms : undefined;
}

/** Epoch milliseconds from an ISO 8601 date, or undefined when unusable. */
export function resetFromIsoDate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
