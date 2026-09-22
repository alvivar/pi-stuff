import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, requestUsageJson, resolveApiKey } from "../src/http.ts";

const URL_UNDER_TEST = "https://example.invalid/usage";

/** Records the single call a test expects and answers with a canned response. */
function stubFetch(respond: (init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return await respond(init);
  };
  return { calls, fetchImpl };
}

function streamOf(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

test("sends a plain GET with the given headers and refuses redirects", async () => {
  const { calls, fetchImpl } = stubFetch(() => Response.json({ ok: 1 }));

  const result = await requestUsageJson(URL_UNDER_TEST, { Authorization: "Bearer t" }, { fetch: fetchImpl });

  assert.deepEqual(result, { ok: true, body: { ok: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, URL_UNDER_TEST);
  assert.equal(calls[0]?.init.method, "GET");
  assert.deepEqual(calls[0]?.init.headers, { Authorization: "Bearer t" });
  assert.equal(calls[0]?.init.redirect, "error");
  assert.ok(calls[0]?.init.signal instanceof AbortSignal);
  assert.equal(calls[0]?.init.body, undefined);
});

test("reads a chunked body without Content-Length", async () => {
  const { fetchImpl } = stubFetch(() => streamOf(['{"usage"', ':{"rolling"', ":{}}}"]));

  const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl });

  assert.deepEqual(result, { ok: true, body: { usage: { rolling: {} } } });
});

test("stops at the size cap even when Content-Length lies", async () => {
  const oversized = "x".repeat(MAX_RESPONSE_BYTES + 1);
  const { fetchImpl } = stubFetch(() => streamOf([`"`, oversized, `"`], { "content-length": "3" }));

  const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl });

  assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Unexpected response" } });
});

test("accepts a body that stays within the cap", async () => {
  const filler = "y".repeat(MAX_RESPONSE_BYTES - 32);
  const { fetchImpl } = stubFetch(() => streamOf([JSON.stringify({ filler })]));

  const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl });

  assert.deepEqual(result, { ok: true, body: { filler } });
});

test("invalid JSON is reported without echoing the body", async () => {
  const { fetchImpl } = stubFetch(() => new Response("<html>secret-ish</html>"));

  const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl });

  assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Unexpected response" } });
});

test("rejected authorization is reported without remote text", async () => {
  for (const status of [401, 403]) {
    const { fetchImpl } = stubFetch(() => new Response("token nope, user@example.com", { status }));

    const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl });

    assert.deepEqual(result, { ok: false, error: { kind: "auth", message: "Access rejected" } });
  }
});

test("other HTTP errors are reported without remote text", async () => {
  for (const status of [400, 404, 500, 503]) {
    const { fetchImpl } = stubFetch(() => new Response("upstream detail", { status }));

    const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl });

    assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Request failed" } });
  }
});

test("rate limit keeps a usable Retry-After and drops an unusable one", async () => {
  const seconds = stubFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "12" } }));
  assert.deepEqual(await requestUsageJson(URL_UNDER_TEST, {}, { fetch: seconds.fetchImpl }), {
    ok: false,
    error: { kind: "rate-limit", message: "Rate limited", retryAfterMs: 12_000 },
  });

  const httpDate = stubFetch(
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": new Date(Date.now() + 60_000).toUTCString() },
      }),
  );
  const dated = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: httpDate.fetchImpl });
  assert.equal(dated.ok, false);
  assert.equal(dated.ok === false && dated.error.kind, "rate-limit");
  const retryAfterMs = dated.ok === false ? (dated.error.retryAfterMs ?? 0) : 0;
  assert.ok(retryAfterMs > 55_000 && retryAfterMs <= 60_000, `unexpected retryAfterMs ${retryAfterMs}`);

  const unusable = [
    "",
    "soon",
    "0",
    "-5",
    "1.5", // fractional seconds are not delay-seconds
    "1e3", // exponential form is not delay-seconds
    "1e308", // would overflow once scaled to milliseconds
    "9".repeat(400), // digits that overflow to Infinity milliseconds
    new Date(Date.now() - 60_000).toUTCString(),
  ];

  for (const header of unusable) {
    const invalid = stubFetch(() => new Response("", { status: 429, headers: { "retry-after": header } }));

    assert.deepEqual(await requestUsageJson(URL_UNDER_TEST, {}, { fetch: invalid.fetchImpl }), {
      ok: false,
      error: { kind: "rate-limit", message: "Rate limited" },
    });
  }

  const missing = stubFetch(() => new Response("", { status: 429 }));
  assert.deepEqual(await requestUsageJson(URL_UNDER_TEST, {}, { fetch: missing.fetchImpl }), {
    ok: false,
    error: { kind: "rate-limit", message: "Rate limited" },
  });
});

/** Response whose body stays open until the request signal aborts it. */
function pendingBodyResponse(signal: AbortSignal | null | undefined, abortNow?: () => void): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"rate_limit":'));
      signal?.addEventListener("abort", () => controller.error(signal.reason));
      abortNow?.();
    },
  });
  return new Response(body);
}

test("a timeout while reading the body is reported as a timeout", async () => {
  const { fetchImpl } = stubFetch((init) => pendingBodyResponse(init.signal));

  const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl, timeoutMs: 10 });

  assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Request timed out" } });
});

test("caller cancellation while reading the body is not reported as a timeout", async () => {
  const controller = new AbortController();
  const { fetchImpl } = stubFetch((init) => pendingBodyResponse(init.signal, () => controller.abort()));

  const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl, signal: controller.signal });

  assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Request failed" } });
});

test("a failing transport is reported as a failed request", async () => {
  const { fetchImpl } = stubFetch(() => {
    throw new TypeError("fetch failed: unexpected redirect to https://evil.invalid");
  });

  const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl });

  assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Request failed" } });
});

test("the request times out and the transport sees the abort", async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 7_000);

  let seen: AbortSignal | undefined;
  const fetchImpl: typeof fetch = (_input, init = {}) =>
    new Promise((_resolve, reject) => {
      seen = init.signal ?? undefined;
      seen?.addEventListener("abort", () => reject(seen?.reason));
    });

  const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl, timeoutMs: 10 });

  assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Request timed out" } });
  assert.equal(seen?.aborted, true);
});

test("caller cancellation aborts the transport and is not reported as a timeout", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const fetchImpl: typeof fetch = (_input, init = {}) =>
    new Promise((_resolve, reject) => {
      seen = init.signal ?? undefined;
      seen?.addEventListener("abort", () => reject(seen?.reason));
      controller.abort();
    });

  const result = await requestUsageJson(URL_UNDER_TEST, {}, { fetch: fetchImpl, signal: controller.signal });

  assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Request failed" } });
  assert.equal(seen?.aborted, true);
});

test("credential resolution yields the key, or nothing when it is missing or fails", async () => {
  const resolved = await resolveApiKey({ getProviderAuth: async () => ({ auth: { apiKey: "key-123" } }) }, "opencode-go");
  assert.equal(resolved, "key-123");

  assert.equal(await resolveApiKey({ getProviderAuth: async () => undefined }, "opencode-go"), undefined);
  assert.equal(await resolveApiKey({ getProviderAuth: async () => ({ auth: {} }) }, "opencode-go"), undefined);
  assert.equal(
    await resolveApiKey(
      {
        getProviderAuth: async () => {
          throw new Error("refresh failed");
        },
      },
      "openai-codex",
    ),
    undefined,
  );
});
