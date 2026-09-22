import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCodexQuota } from "../src/codex.ts";
import { parseOpencodeGoQuota } from "../src/opencode-go.ts";

test("codex: full response yields both windows with remaining percent and reset in ms", () => {
  const quota = parseCodexQuota({
    rate_limit: {
      primary_window: { used_percent: 37, reset_at: 1_760_000_000 },
      secondary_window: { used_percent: 12.4, reset_at: 1_760_400_000 },
    },
  });

  assert.deepEqual(quota, {
    provider: "openai-codex",
    windows: [
      { kind: "5h", remainingPercent: 63, resetsAt: 1_760_000_000_000 },
      { kind: "weekly", remainingPercent: 88, resetsAt: 1_760_400_000_000 },
    ],
  });
});

test("codex: a missing window is omitted instead of assumed available", () => {
  const quota = parseCodexQuota({
    rate_limit: { secondary_window: { used_percent: 100, reset_at: 1_760_000_000 } },
  });

  assert.deepEqual(quota, {
    provider: "openai-codex",
    windows: [{ kind: "weekly", remainingPercent: 0, resetsAt: 1_760_000_000_000 }],
  });
});

test("codex: unusable reset keeps the window with an unknown reset", () => {
  const unusable = [
    undefined,
    "1760000000",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -5,
    Number.MAX_VALUE, // overflows to Infinity milliseconds
    8_640_000_000_001, // one second past the last instant Date can represent
  ];

  for (const reset_at of unusable) {
    const quota = parseCodexQuota({ rate_limit: { primary_window: { used_percent: 50, reset_at } } });

    assert.deepEqual(quota, {
      provider: "openai-codex",
      windows: [{ kind: "5h", remainingPercent: 50, resetsAt: undefined }],
    });
  }
});

test("codex: windows without a usable percent are discarded", () => {
  for (const used_percent of [undefined, null, "37", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      parseCodexQuota({ rate_limit: { primary_window: { used_percent, reset_at: 1_760_000_000 } } }),
      undefined,
    );
  }

  assert.deepEqual(
    parseCodexQuota({
      rate_limit: {
        primary_window: { used_percent: "37" },
        secondary_window: { used_percent: 20, reset_at: 1_760_000_000 },
      },
    }),
    {
      provider: "openai-codex",
      windows: [{ kind: "weekly", remainingPercent: 80, resetsAt: 1_760_000_000_000 }],
    },
  );
});

test("codex: out-of-range percentages are clamped to 0-100 remaining", () => {
  assert.deepEqual(
    parseCodexQuota({
      rate_limit: {
        primary_window: { used_percent: 140 },
        secondary_window: { used_percent: -20 },
      },
    }),
    {
      provider: "openai-codex",
      windows: [
        { kind: "5h", remainingPercent: 0, resetsAt: undefined },
        { kind: "weekly", remainingPercent: 100, resetsAt: undefined },
      ],
    },
  );
});

test("codex: responses without a rate limit object are unusable", () => {
  for (const body of [undefined, null, "{}", 7, [], {}, { rate_limit: null }, { rate_limit: [] }]) {
    assert.equal(parseCodexQuota(body), undefined);
  }
});

test("opencode-go: full response yields rolling, weekly and monthly windows", () => {
  const quota = parseOpencodeGoQuota({
    usage: {
      rolling: { percent: 5, resetsAt: "2026-01-02T03:04:05.000Z" },
      weekly: { percent: 41.6, resetsAt: "2026-01-08T00:00:00.000Z" },
      monthly: { percent: 0, resetsAt: "2026-02-01T00:00:00.000Z" },
    },
  });

  assert.deepEqual(quota, {
    provider: "opencode-go",
    windows: [
      { kind: "rolling", remainingPercent: 95, resetsAt: Date.parse("2026-01-02T03:04:05.000Z") },
      { kind: "weekly", remainingPercent: 58, resetsAt: Date.parse("2026-01-08T00:00:00.000Z") },
      { kind: "monthly", remainingPercent: 100, resetsAt: Date.parse("2026-02-01T00:00:00.000Z") },
    ],
  });
});

test("opencode-go: partial responses report only the windows that arrived", () => {
  const quota = parseOpencodeGoQuota({
    usage: { weekly: { percent: 30, resetsAt: "2026-01-08T00:00:00.000Z" } },
  });

  assert.deepEqual(quota, {
    provider: "opencode-go",
    windows: [{ kind: "weekly", remainingPercent: 70, resetsAt: Date.parse("2026-01-08T00:00:00.000Z") }],
  });
});

test("opencode-go: invalid dates leave the reset unknown", () => {
  const unusable = [
    undefined,
    "",
    "not-a-date",
    1_760_000_000,
    "2026-13-45T00:00:00Z",
    "+275760-09-14T00:00:00.000Z", // one day past the last instant Date can represent
  ];

  for (const resetsAt of unusable) {
    const quota = parseOpencodeGoQuota({ usage: { rolling: { percent: 25, resetsAt } } });

    assert.deepEqual(quota, {
      provider: "opencode-go",
      windows: [{ kind: "rolling", remainingPercent: 75, resetsAt: undefined }],
    });
  }
});

test("opencode-go: windows without a usable percent are discarded", () => {
  assert.equal(
    parseOpencodeGoQuota({ usage: { rolling: { resetsAt: "2026-01-02T03:04:05.000Z" } } }),
    undefined,
  );

  assert.deepEqual(
    parseOpencodeGoQuota({
      usage: {
        rolling: { percent: "5" },
        monthly: { percent: 10, resetsAt: "2026-02-01T00:00:00.000Z" },
      },
    }),
    {
      provider: "opencode-go",
      windows: [{ kind: "monthly", remainingPercent: 90, resetsAt: Date.parse("2026-02-01T00:00:00.000Z") }],
    },
  );
});

test("opencode-go: responses without a usage object are unusable", () => {
  for (const body of [undefined, null, "{}", 7, [], {}, { usage: "none" }, { usage: {} }]) {
    assert.equal(parseOpencodeGoQuota(body), undefined);
  }
});
