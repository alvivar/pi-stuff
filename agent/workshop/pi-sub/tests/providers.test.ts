import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchCodexQuota } from "../src/codex.ts";
import type { AuthSource } from "../src/http.ts";
import { fetchOpencodeGoQuota } from "../src/opencode-go.ts";

const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_GO_URL = "https://opencode.ai/zen/go/v1/usage";

/** Fictitious unsigned token carrying only the claim the Codex endpoint needs. */
function fakeAccessToken(claims: unknown): string {
  const segment = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `header-part.${segment}.signature-part`;
}

const CODEX_CLAIMS = { "https://api.openai.com/auth": { chatgpt_account_id: "acct-fake-1" } };
const CODEX_TOKEN = fakeAccessToken(CODEX_CLAIMS);
const CODEX_PAYLOAD = CODEX_TOKEN.split(".")[1];

function authWith(apiKey: string | undefined): AuthSource {
  return { getProviderAuth: async () => (apiKey === undefined ? undefined : { auth: { apiKey } }) };
}

function stubFetch(respond: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return respond();
  };
  return { calls, fetchImpl };
}

test("codex: queries the fixed endpoint with bearer token and account header", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    Response.json({
      rate_limit: {
        primary_window: { used_percent: 25, reset_at: 1_760_000_000 },
        secondary_window: { used_percent: 60, reset_at: 1_760_400_000 },
      },
    }),
  );

  const result = await fetchCodexQuota({ auth: authWith(CODEX_TOKEN), fetch: fetchImpl });

  assert.deepEqual(result, {
    ok: true,
    quota: {
      provider: "openai-codex",
      windows: [
        { kind: "5h", remainingPercent: 75, resetsAt: 1_760_000_000_000 },
        { kind: "weekly", remainingPercent: 40, resetsAt: 1_760_400_000_000 },
      ],
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, CODEX_URL);
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.redirect, "error");
  assert.deepEqual(calls[0]?.init.headers, {
    Accept: "application/json",
    Authorization: `Bearer ${CODEX_TOKEN}`,
    "ChatGPT-Account-Id": "acct-fake-1",
  });
});

test("codex: no credential, no account claim and failed resolution never reach the network", async () => {
  const sources: AuthSource[] = [
    authWith(undefined),
    { getProviderAuth: async () => ({ auth: {} }) },
    authWith(fakeAccessToken({ sub: "user" })),
    authWith(fakeAccessToken({ "https://api.openai.com/auth": { chatgpt_account_id: "" } })),
    authWith("not-a-jwt"),
    authWith(`header-part.${CODEX_PAYLOAD}`), // two segments
    authWith(`header-part.${CODEX_PAYLOAD}.signature-part.extra`), // four segments
    authWith(`.${CODEX_PAYLOAD}.`), // empty header and signature
    authWith(`header-part.${CODEX_PAYLOAD}!!!.signature-part`), // payload is not base64url
    authWith("header-part..signature-part"), // empty payload
    authWith(`header part.${CODEX_PAYLOAD}.signature-part`), // header is not base64url
    {
      getProviderAuth: async () => {
        throw new Error("refresh failed");
      },
    },
  ];

  for (const auth of sources) {
    const { calls, fetchImpl } = stubFetch(() => Response.json({}));

    const result = await fetchCodexQuota({ auth, fetch: fetchImpl });

    assert.deepEqual(result, { ok: false, error: { kind: "auth", message: "Sign in required" } });
    assert.equal(calls.length, 0);
  }
});

test("codex: an unusable payload is reported as an unexpected response", async () => {
  for (const body of [{}, { rate_limit: {} }, { rate_limit: { primary_window: { used_percent: "30" } } }]) {
    const { fetchImpl } = stubFetch(() => Response.json(body));

    const result = await fetchCodexQuota({ auth: authWith(CODEX_TOKEN), fetch: fetchImpl });

    assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Unexpected response" } });
  }
});

test("codex: transport failures surface unchanged and never leak the token", async () => {
  const { fetchImpl } = stubFetch(
    () => new Response("token acct-fake-1 rejected", { status: 429, headers: { "retry-after": "30" } }),
  );

  const result = await fetchCodexQuota({ auth: authWith(CODEX_TOKEN), fetch: fetchImpl });

  assert.deepEqual(result, {
    ok: false,
    error: { kind: "rate-limit", message: "Rate limited", retryAfterMs: 30_000 },
  });
  assert.equal(JSON.stringify(result).includes(CODEX_TOKEN), false);
  assert.equal(JSON.stringify(result).includes("acct-fake-1"), false);
});

test("opencode-go: queries the fixed endpoint with the API key as bearer", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    Response.json({
      usage: {
        rolling: { percent: 10, resetsAt: "2026-01-02T03:04:05.000Z" },
        monthly: { percent: 80, resetsAt: "2026-02-01T00:00:00.000Z" },
      },
    }),
  );

  const result = await fetchOpencodeGoQuota({ auth: authWith("oc-key-fake"), fetch: fetchImpl });

  assert.deepEqual(result, {
    ok: true,
    quota: {
      provider: "opencode-go",
      windows: [
        { kind: "rolling", remainingPercent: 90, resetsAt: Date.parse("2026-01-02T03:04:05.000Z") },
        { kind: "monthly", remainingPercent: 20, resetsAt: Date.parse("2026-02-01T00:00:00.000Z") },
      ],
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, OPENCODE_GO_URL);
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.redirect, "error");
  assert.deepEqual(calls[0]?.init.headers, {
    Accept: "application/json",
    Authorization: "Bearer oc-key-fake",
  });
});

test("opencode-go: a missing API key never reaches the network", async () => {
  for (const auth of [authWith(undefined), { getProviderAuth: async () => ({ auth: {} }) } as AuthSource]) {
    const { calls, fetchImpl } = stubFetch(() => Response.json({}));

    const result = await fetchOpencodeGoQuota({ auth, fetch: fetchImpl });

    assert.deepEqual(result, { ok: false, error: { kind: "auth", message: "Sign in required" } });
    assert.equal(calls.length, 0);
  }
});

test("opencode-go: an unusable payload is reported as an unexpected response", async () => {
  const { fetchImpl } = stubFetch(() => Response.json({ usage: { rolling: { percent: null } } }));

  const result = await fetchOpencodeGoQuota({ auth: authWith("oc-key-fake"), fetch: fetchImpl });

  assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Unexpected response" } });
});

test("opencode-go: caller cancellation reaches the transport", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const fetchImpl: typeof fetch = (_input, init = {}) =>
    new Promise((_resolve, reject) => {
      seen = init.signal ?? undefined;
      seen?.addEventListener("abort", () => reject(seen?.reason));
      controller.abort();
    });

  const result = await fetchOpencodeGoQuota({
    auth: authWith("oc-key-fake"),
    fetch: fetchImpl,
    signal: controller.signal,
  });

  assert.deepEqual(result, { ok: false, error: { kind: "failed", message: "Request failed" } });
  assert.equal(seen?.aborted, true);
});
