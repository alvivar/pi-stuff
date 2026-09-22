import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDetail, formatDuration, formatStatus, type QuotaView } from "../src/presentation.ts";

const NOW = Date.parse("2026-01-02T00:00:00.000Z");

function viewOf(patch: Partial<QuotaView> = {}): QuotaView {
  return {
    provider: "openai-codex",
    loading: false,
    quota: undefined,
    quotaAt: undefined,
    error: undefined,
    ...patch,
  };
}

const READY = viewOf({
  quota: {
    provider: "openai-codex",
    windows: [
      { kind: "5h", remainingPercent: 75, resetsAt: NOW + 4 * 3_600_000 + 12 * 60_000 },
      { kind: "weekly", remainingPercent: 40, resetsAt: NOW + 3 * 86_400_000 },
    ],
  },
  quotaAt: NOW - 12_000,
});

test("status shows provider, remaining percent and countdown", () => {
  assert.equal(formatStatus(READY, NOW), "sub codex | 5h 75% in 4h 12m | weekly 40% in 3d 0h");
});

test("countdown is recomputed from the current time, not stored", () => {
  assert.equal(formatStatus(READY, NOW + 3_600_000), "sub codex | 5h 75% in 3h 12m | weekly 40% in 2d 23h");
  assert.equal(formatStatus(READY, NOW + 10 * 86_400_000), "sub codex | 5h 75% resetting now | weekly 40% resetting now");
});

test("status covers loading, empty, unknown reset and error states", () => {
  assert.equal(formatStatus(viewOf({ loading: true }), NOW), "sub codex | loading...");
  assert.equal(formatStatus(viewOf(), NOW), "sub codex | no data");
  assert.equal(
    formatStatus(viewOf({ error: { kind: "auth", message: "Sign in required" } }), NOW),
    "sub codex | Sign in required",
  );
  assert.equal(
    formatStatus(
      viewOf({
        provider: "opencode-go",
        quota: { provider: "opencode-go", windows: [{ kind: "rolling", remainingPercent: 90, resetsAt: undefined }] },
        quotaAt: NOW,
      }),
      NOW,
    ),
    "sub opencode | rolling 90% reset unknown",
  );
});

test("kept data is marked stale with its age when the last attempt failed", () => {
  const stale = { ...READY, quotaAt: NOW - 185_000, error: { kind: "failed" as const, message: "Request failed" } };

  assert.equal(formatStatus(stale, NOW), "sub codex | 5h 75% in 4h 12m | weekly 40% in 3d 0h | stale 3m");
  assert.match(formatDetail(stale, NOW), /updated 3m ago/);
  assert.match(formatDetail(stale, NOW), /last attempt: Request failed/);
});

test("detail lists the windows and the age of the reading", () => {
  assert.equal(
    formatDetail(READY, NOW),
    [
      "pi-sub: codex",
      "5h: 75% left, in 4h 12m",
      "weekly: 40% left, in 3d 0h",
      "updated 12s ago",
    ].join("\n"),
  );
  assert.equal(formatDetail(undefined, NOW), "pi-sub: no supported provider active");
  assert.equal(formatDetail(viewOf(), NOW), "pi-sub: codex\nno data yet");
  assert.equal(formatDetail(viewOf({ loading: true }), NOW), "pi-sub: codex\nrefreshing...");
});

test("nothing rendered carries credentials, identities or remote text", () => {
  const rendered = `${formatStatus(READY, NOW)}\n${formatDetail(READY, NOW)}`;

  for (const secret of ["acct-", "Bearer", "eyJ", "@", "sk-", "chatgpt_account_id"]) {
    assert.equal(rendered.includes(secret), false, `rendered output leaked ${secret}`);
  }
});

test("durations degrade from days to seconds", () => {
  assert.equal(formatDuration(3 * 86_400_000 + 4 * 3_600_000), "3d 4h");
  assert.equal(formatDuration(4 * 3_600_000 + 12 * 60_000), "4h 12m");
  assert.equal(formatDuration(3 * 60_000), "3m");
  assert.equal(formatDuration(12_000), "12s");
  assert.equal(formatDuration(-5_000), "0s");
});
