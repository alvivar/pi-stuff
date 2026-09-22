/**
 * Session-scoped quota polling: at most one request in flight, fixed cadence,
 * and no work at all until a session starts it.
 */

import { fetchCodexQuota } from "./codex.ts";
import type { AuthSource, QuotaFailure, QuotaResult } from "./http.ts";
import { fetchOpencodeGoQuota } from "./opencode-go.ts";
import type { QuotaView } from "./presentation.ts";
import type { ProviderId, Quota } from "./quota.ts";

export const REFRESH_INTERVAL_MS = 60_000;
export const MANUAL_MIN_INTERVAL_MS = 10_000;

/** Node fires a longer timeout immediately, so long waits are served in slices. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const REQUEST_FAILED: QuotaFailure = { kind: "failed", message: "Request failed" };

export type QuotaQuery = (provider: ProviderId, signal: AbortSignal) => Promise<QuotaResult>;

export type QuotaRuntimeDeps = {
  query: QuotaQuery;
  /** Called on every state change; `undefined` means "show nothing". */
  onView: (view: QuotaView | undefined) => void;
  now?: () => number;
  /** Schedules the next attempt and returns its cancel function. */
  setTimer?: (delayMs: number, run: () => void) => () => void;
};

export type RefreshOutcome =
  | { started: true }
  | { started: false; reason: "inactive" }
  | { started: false; reason: "busy" }
  | { started: false; reason: "wait"; waitMs: number };

export type QuotaRuntime = {
  /** Follow a provider, or `undefined` to show nothing and stay idle. */
  activate(provider: ProviderId | undefined): void;
  refresh(): RefreshOutcome;
  view(): QuotaView | undefined;
  /** Cancels request and timer; safe to call repeatedly. */
  stop(): void;
};

/** The only two providers we know how to read. */
export function supportedProvider(provider: string | undefined): ProviderId | undefined {
  return provider === "openai-codex" || provider === "opencode-go" ? provider : undefined;
}

export function createQuotaQuery(auth: AuthSource): QuotaQuery {
  return (provider, signal) =>
    provider === "openai-codex" ? fetchCodexQuota({ auth, signal }) : fetchOpencodeGoQuota({ auth, signal });
}

export function createQuotaRuntime(deps: QuotaRuntimeDeps): QuotaRuntime {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? defaultTimer;

  let provider: ProviderId | undefined;
  /** Opaque credential identity, kept in memory only to notice account changes. */
  let identity: string | undefined;
  let quota: Quota | undefined;
  let quotaAt: number | undefined;
  let error: QuotaFailure | undefined;
  let loading = false;
  /** The active request is its own identity: a stale reply fails this check. */
  let request: AbortController | undefined;
  let cancelTimer: (() => void) | undefined;
  let lastAttemptAt: number | undefined;
  let blockedUntil: number | undefined;

  function view(): QuotaView | undefined {
    return provider === undefined ? undefined : { provider, loading, quota, quotaAt, error };
  }

  function emit(): void {
    deps.onView(view());
  }

  function reset(): void {
    cancelTimer?.();
    cancelTimer = undefined;
    request?.abort();
    request = undefined;
    provider = undefined;
    identity = undefined;
    quota = undefined;
    quotaAt = undefined;
    error = undefined;
    loading = false;
    lastAttemptAt = undefined;
    blockedUntil = undefined;
  }

  function scheduleAt(target: number): void {
    cancelTimer?.();
    const delay = Math.min(Math.max(target - now(), 0), MAX_TIMER_DELAY_MS);
    cancelTimer = setTimer(delay, () => {
      cancelTimer = undefined;
      // A sliced wait resumes here; the deadline still decides when we may query.
      if (now() < target) {
        scheduleAt(target);
        return;
      }
      startAttempt();
    });
  }

  function schedule(): void {
    scheduleAt(Math.max(now() + REFRESH_INTERVAL_MS, blockedUntil ?? 0));
  }

  function apply(result: QuotaResult): void {
    // A different account or credential invalidates what we were showing.
    if (result.identity !== identity) {
      identity = result.identity;
      quota = undefined;
      quotaAt = undefined;
    }

    if (result.ok) {
      quota = result.quota;
      quotaAt = now();
      error = undefined;
      blockedUntil = undefined;
      return;
    }

    error = result.error;
    if (result.error.kind === "rate-limit") {
      blockedUntil = now() + (result.error.retryAfterMs ?? REFRESH_INTERVAL_MS);
    }
  }

  async function attempt(): Promise<void> {
    const active = provider;
    if (active === undefined || request !== undefined) return;

    const current = new AbortController();
    request = current;
    lastAttemptAt = now();
    loading = true;
    emit();

    let result: QuotaResult;
    try {
      result = await deps.query(active, current.signal);
    } catch {
      // The attempt never confirmed an identity, so its data cannot be kept as ours.
      result = { ok: false, identity: undefined, error: REQUEST_FAILED };
    }

    // Anything that replaced or cancelled this request owns the state now.
    if (request !== current) return;

    request = undefined;
    loading = false;
    apply(result);
    emit();
    schedule();
  }

  /** Deferred entry point: a rejection here must never reach Pi as an unhandled error. */
  function startAttempt(): void {
    void attempt().catch(() => {
      request = undefined;
      loading = false;
      identity = undefined;
      quota = undefined;
      quotaAt = undefined;
      error = REQUEST_FAILED;
      schedule();
    });
  }

  return {
    activate(next: ProviderId | undefined): void {
      if (next !== undefined && next === provider) return; // Another model of the same provider.

      reset();
      if (next === undefined) {
        deps.onView(undefined);
        return;
      }

      provider = next;
      startAttempt();
    },

    refresh(): RefreshOutcome {
      if (provider === undefined) return { started: false, reason: "inactive" };
      if (request !== undefined) return { started: false, reason: "busy" };

      const manualAllowedAt = lastAttemptAt === undefined ? 0 : lastAttemptAt + MANUAL_MIN_INTERVAL_MS;
      const allowedAt = Math.max(manualAllowedAt, blockedUntil ?? 0);
      const waitMs = allowedAt - now();
      if (waitMs > 0) return { started: false, reason: "wait", waitMs };

      cancelTimer?.();
      cancelTimer = undefined;
      startAttempt();
      return { started: true };
    },

    view,

    stop(): void {
      reset();
      deps.onView(undefined);
    },
  };
}

function defaultTimer(delayMs: number, run: () => void): () => void {
  const handle = setTimeout(run, delayMs);
  handle.unref();
  return () => clearTimeout(handle);
}
