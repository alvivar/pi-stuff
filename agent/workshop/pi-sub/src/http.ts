/**
 * Shared transport for the two usage endpoints: credential lookup through Pi's
 * public registry, fixed timeout, capped response and rejected redirects.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { ProviderId, Quota } from "./quota.ts";

/** The part of Pi's public registry we need; `ctx.modelRegistry` satisfies it. */
export type AuthSource = Pick<ModelRegistry, "getProviderAuth">;

export const REQUEST_TIMEOUT_MS = 7_000;

/** Usage payloads are a few hundred bytes; anything larger is not one. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** Short local reason a quota is unavailable. Remote text is never reused. */
export type QuotaFailure = {
  kind: "auth" | "rate-limit" | "failed";
  message: string;
  /** Only for "rate-limit", and only when the server sent a usable Retry-After. */
  retryAfterMs?: number;
};

/**
 * `identity` is an opaque credential identity used in memory to notice account or
 * key changes; it is never shown, logged or persisted. Codex reports its stable
 * account ID, OpenCode Go has no such field and reports the key itself.
 */
export type QuotaResult =
  | { ok: true; identity: string; quota: Quota }
  | { ok: false; identity: string | undefined; error: QuotaFailure };

export const SIGN_IN_REQUIRED: QuotaFailure = { kind: "auth", message: "Sign in required" };
export const UNEXPECTED_RESPONSE: QuotaFailure = { kind: "failed", message: "Unexpected response" };

export type QuotaRequestOptions = {
  auth: AuthSource;
  /** Injection seam for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

/** Current API key for a provider, or undefined when there is nothing usable. */
export async function resolveApiKey(auth: AuthSource, provider: ProviderId): Promise<string | undefined> {
  try {
    const apiKey = (await auth.getProviderAuth(provider))?.auth.apiKey;
    return apiKey ? apiKey : undefined;
  } catch {
    // An expired login or a failed refresh reads the same as no credential here.
    return undefined;
  }
}

/** GET a fixed usage endpoint and return its JSON body, or a local failure. */
export async function requestUsageJson(
  url: string,
  headers: Record<string, string>,
  options: Omit<QuotaRequestOptions, "auth"> & { timeoutMs?: number },
): Promise<{ ok: true; body: unknown } | { ok: false; error: QuotaFailure }> {
  const fetchImpl = options.fetch ?? fetch;
  // AbortSignal.timeout owns its timer and does not hold the event loop open.
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  // Network error, rejected redirect, timeout or caller cancellation.
  const transportFailure = (): QuotaFailure => ({
    kind: "failed",
    message: timeout.aborted ? "Request timed out" : "Request failed",
  });

  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal });
  } catch {
    return { ok: false, error: transportFailure() };
  }

  if (!response.ok) {
    const error = statusFailure(response);
    await response.body?.cancel().catch(() => {});
    return { ok: false, error };
  }

  // The timeout covers the whole response, so a failed read is still transport.
  let text: string | undefined;
  try {
    text = await readCappedText(response);
  } catch {
    return { ok: false, error: transportFailure() };
  }
  if (text === undefined) return { ok: false, error: UNEXPECTED_RESPONSE };

  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, error: UNEXPECTED_RESPONSE };
  }
}

/** Body text, or undefined when absent or larger than the cap. Content-Length is not trusted. */
async function readCappedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;

  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return text + decoder.decode();
}

function statusFailure(response: Response): QuotaFailure {
  if (response.status === 401 || response.status === 403) return { kind: "auth", message: "Access rejected" };
  if (response.status !== 429) return { kind: "failed", message: "Request failed" };

  const retryAfterMs = retryAfterToMs(response.headers.get("retry-after"));
  return retryAfterMs === undefined
    ? { kind: "rate-limit", message: "Rate limited" }
    : { kind: "rate-limit", message: "Rate limited", retryAfterMs };
}

/** Retry-After in milliseconds, from delay-seconds or an HTTP date; undefined when unusable. */
function retryAfterToMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const header = value.trim();

  // delay-seconds is 1*DIGIT; huge values overflow to Infinity and are not delays.
  if (/^\d+$/.test(header)) {
    const delay = Number(header) * 1000;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }

  const delay = Date.parse(header) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}
