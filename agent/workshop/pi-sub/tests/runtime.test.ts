import assert from "node:assert/strict";
import { test } from "node:test";

import extension from "../extensions/index.ts";
import type { QuotaFailure, QuotaResult } from "../src/http.ts";
import type { QuotaView } from "../src/presentation.ts";
import { createQuotaRuntime, MAX_TIMER_DELAY_MS, supportedProvider } from "../src/runtime.ts";
import type { ProviderId, Quota } from "../src/quota.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

type PendingQuery = {
  provider: ProviderId;
  signal: AbortSignal;
  resolve: (result: QuotaResult) => void;
  reject: (error: unknown) => void;
};

/** Controlled clock, scheduler and query so the runtime can be driven step by step. */
function harness() {
  let clock = 1_000_000;
  const timers: Array<{ at: number; delay: number; run: () => void; cancelled: boolean }> = [];
  const calls: PendingQuery[] = [];
  const views: Array<QuotaView | undefined> = [];

  const runtime = createQuotaRuntime({
    now: () => clock,
    setTimer: (delayMs, run) => {
      const timer = { at: clock + delayMs, delay: delayMs, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    query: (provider, signal) =>
      new Promise<QuotaResult>((resolve, reject) => {
        calls.push({ provider, signal, resolve, reject });
      }),
    onView: (view) => views.push(view),
  });

  return {
    runtime,
    calls,
    views,
    now: () => clock,
    lastView: () => views[views.length - 1],
    timers,
    pendingTimers: () => timers.filter((timer) => !timer.cancelled),
    advance(ms: number) {
      clock += ms;
    },
    async fireTimers() {
      for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= clock)) {
        timer.cancelled = true;
        timer.run();
      }
      await tick();
    },
    async settle(result: QuotaResult, index = calls.length - 1) {
      calls[index]?.resolve(result);
      await tick();
    },
  };
}

function quotaOf(remainingPercent: number): Quota {
  return { provider: "openai-codex", windows: [{ kind: "5h", remainingPercent, resetsAt: undefined }] };
}

const ok = (identity: string, remainingPercent = 75): QuotaResult => ({
  ok: true,
  identity,
  quota: quotaOf(remainingPercent),
});

const failed = (identity: string | undefined, error: QuotaFailure): QuotaResult => ({ ok: false, identity, error });

const FAILURE: QuotaFailure = { kind: "failed", message: "Request failed" };

test("only the two known provider ids are supported", () => {
  assert.equal(supportedProvider("openai-codex"), "openai-codex");
  assert.equal(supportedProvider("opencode-go"), "opencode-go");
  for (const other of [undefined, "anthropic", "openai", "opencode", "openai-codex-mini", "OPENAI-CODEX"]) {
    assert.equal(supportedProvider(other), undefined);
  }
});

test("a supported provider queries immediately and then on the 60s cadence", async () => {
  const h = harness();

  h.runtime.activate("openai-codex");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.provider, "openai-codex");
  assert.deepEqual(h.lastView(), {
    provider: "openai-codex",
    loading: true,
    quota: undefined,
    quotaAt: undefined,
    error: undefined,
  });

  await h.settle(ok("acct-1"));
  assert.deepEqual(h.lastView(), {
    provider: "openai-codex",
    loading: false,
    quota: quotaOf(75),
    quotaAt: h.now(),
    error: undefined,
  });
  assert.equal(h.pendingTimers().length, 1);
  assert.equal(h.pendingTimers()[0]?.at, h.now() + 60_000);

  h.advance(60_000);
  await h.fireTimers();
  assert.equal(h.calls.length, 2);
});

test("redundant triggers never open a second request", async () => {
  const h = harness();

  h.runtime.activate("openai-codex");
  h.runtime.activate("openai-codex");
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.runtime.refresh(), { started: false, reason: "busy" });
  assert.equal(h.calls.length, 1);

  await h.settle(ok("acct-1"));
  h.runtime.activate("openai-codex"); // Another model of the same provider.
  assert.equal(h.calls.length, 1);
  assert.equal(h.pendingTimers().length, 1);
});

test("switching provider cancels the request, drops old data and ignores the late reply", async () => {
  const h = harness();

  h.runtime.activate("openai-codex");
  await h.settle(ok("acct-1"));
  h.advance(60_000);
  await h.fireTimers();
  assert.equal(h.calls.length, 2);

  h.runtime.activate("opencode-go");
  assert.equal(h.calls[1]?.signal.aborted, true);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2]?.provider, "opencode-go");
  assert.equal(h.lastView()?.quota, undefined);
  assert.equal(h.lastView()?.loading, true);

  const viewCount = h.views.length;
  await h.settle(ok("acct-1"), 1); // Late reply from the abandoned request.
  assert.equal(h.views.length, viewCount);
  assert.equal(h.lastView()?.quota, undefined);
  assert.equal(h.pendingTimers().length, 0);
});

test("an unsupported provider clears the status and stays idle", async () => {
  const h = harness();

  h.runtime.activate(undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(h.pendingTimers().length, 0);
  assert.deepEqual(h.views, [undefined]);
  assert.equal(h.runtime.view(), undefined);

  h.runtime.activate("openai-codex");
  await h.settle(ok("acct-1"));
  h.runtime.activate(undefined);
  assert.equal(h.lastView(), undefined);
  assert.equal(h.runtime.view(), undefined);
  assert.equal(h.pendingTimers().length, 0);
  assert.equal(h.calls.length, 1);
});

test("manual refresh keeps a 10s minimum between attempts", async () => {
  const h = harness();

  assert.deepEqual(h.runtime.refresh(), { started: false, reason: "inactive" });

  h.runtime.activate("openai-codex");
  await h.settle(ok("acct-1"));

  h.advance(4_000);
  assert.deepEqual(h.runtime.refresh(), { started: false, reason: "wait", waitMs: 6_000 });
  assert.equal(h.calls.length, 1);

  h.advance(6_000);
  assert.deepEqual(h.runtime.refresh(), { started: true });
  assert.equal(h.calls.length, 2);
  assert.equal(h.pendingTimers().length, 0); // The cadence timer is replaced by this attempt.

  await h.settle(ok("acct-1"));
  assert.equal(h.pendingTimers().length, 1);
});

test("a rate limit blocks until Retry-After, and falls back to the normal cadence", async () => {
  const h = harness();

  h.runtime.activate("openai-codex");
  await h.settle(failed("acct-1", { kind: "rate-limit", message: "Rate limited", retryAfterMs: 120_000 }));
  assert.equal(h.pendingTimers()[0]?.at, h.now() + 120_000);

  h.advance(20_000);
  assert.deepEqual(h.runtime.refresh(), { started: false, reason: "wait", waitMs: 100_000 });
  assert.equal(h.calls.length, 1);

  h.advance(100_000);
  assert.deepEqual(h.runtime.refresh(), { started: true });

  await h.settle(failed("acct-1", { kind: "rate-limit", message: "Rate limited" }));
  assert.equal(h.pendingTimers()[0]?.at, h.now() + 60_000);
  h.advance(30_000);
  assert.deepEqual(h.runtime.refresh(), { started: false, reason: "wait", waitMs: 30_000 });
});

test("a transient failure keeps the last data as stale without retrying immediately", async () => {
  const h = harness();

  h.runtime.activate("openai-codex");
  await h.settle(ok("acct-1"));
  const readAt = h.now();

  h.advance(60_000);
  await h.fireTimers();
  await h.settle(failed("acct-1", FAILURE));

  assert.deepEqual(h.lastView(), {
    provider: "openai-codex",
    loading: false,
    quota: quotaOf(75),
    quotaAt: readAt,
    error: FAILURE,
  });
  assert.equal(h.pendingTimers().length, 1);
  assert.equal(h.pendingTimers()[0]?.at, h.now() + 60_000);
});

test("a changed credential identity discards the previous quota", async () => {
  const h = harness();

  h.runtime.activate("openai-codex");
  await h.settle(ok("acct-1"));

  h.advance(60_000);
  await h.fireTimers();
  await h.settle(failed("acct-2", { kind: "auth", message: "Access rejected" }));
  assert.equal(h.lastView()?.quota, undefined);
  assert.equal(h.lastView()?.quotaAt, undefined);
  assert.deepEqual(h.lastView()?.error, { kind: "auth", message: "Access rejected" });

  h.advance(60_000);
  await h.fireTimers();
  await h.settle(ok("acct-2", 30));
  assert.deepEqual(h.lastView()?.quota, quotaOf(30));

  h.advance(60_000);
  await h.fireTimers();
  await h.settle(failed(undefined, { kind: "auth", message: "Sign in required" }));
  assert.equal(h.lastView()?.quota, undefined);
});

test("the view never carries the credential identity", async () => {
  const h = harness();

  h.runtime.activate("opencode-go");
  await h.settle(ok("oc-key-secret-123"));

  assert.equal(JSON.stringify(h.runtime.view()).includes("oc-key-secret-123"), false);
  assert.equal(JSON.stringify(h.views).includes("oc-key-secret-123"), false);
});

test("a rejected query becomes a local failure on the normal cadence", async () => {
  const h = harness();

  h.runtime.activate("openai-codex");
  h.calls[0]?.reject(new Error("unexpected"));
  await tick();

  assert.deepEqual(h.lastView()?.error, FAILURE);
  assert.equal(h.pendingTimers().length, 1);
  assert.equal(h.pendingTimers()[0]?.at, h.now() + 60_000);
});

test("a rejected query cannot keep data: its identity was never confirmed", async () => {
  const h = harness();

  h.runtime.activate("openai-codex");
  await h.settle(ok("acct-1"));

  h.advance(60_000);
  await h.fireTimers();
  h.calls[1]?.reject(new Error("unexpected"));
  await tick();

  assert.deepEqual(h.lastView(), {
    provider: "openai-codex",
    loading: false,
    quota: undefined,
    quotaAt: undefined,
    error: FAILURE,
  });
});

test("a long Retry-After is waited out in timer slices, without querying early", async () => {
  const h = harness();
  const thirtyDays = 30 * 86_400_000;

  h.runtime.activate("openai-codex");
  await h.settle(failed("acct-1", { kind: "rate-limit", message: "Rate limited", retryAfterMs: thirtyDays }));
  const deadline = h.now() + thirtyDays;

  assert.equal(h.pendingTimers().length, 1);
  assert.equal(h.pendingTimers()[0]?.delay, MAX_TIMER_DELAY_MS);

  h.advance(MAX_TIMER_DELAY_MS);
  await h.fireTimers();
  assert.equal(h.calls.length, 1); // The deadline has not passed yet.
  assert.equal(h.pendingTimers().length, 1);
  assert.equal(h.pendingTimers()[0]?.at, deadline);
  assert.deepEqual(h.runtime.refresh(), { started: false, reason: "wait", waitMs: deadline - h.now() });

  h.advance(deadline - h.now());
  await h.fireTimers();
  assert.equal(h.calls.length, 2);

  for (const timer of h.timers) assert.ok(timer.delay <= MAX_TIMER_DELAY_MS, `timer delay ${timer.delay} overflows`);
});

test("stop cancels request and timer, is idempotent and ignores late replies", async () => {
  const h = harness();

  h.runtime.activate("openai-codex");
  await h.settle(ok("acct-1"));
  h.advance(60_000);
  await h.fireTimers();

  h.runtime.stop();
  assert.equal(h.calls[1]?.signal.aborted, true);
  assert.equal(h.pendingTimers().length, 0);
  assert.equal(h.lastView(), undefined);

  const viewCount = h.views.length;
  h.runtime.stop();
  assert.equal(h.views.length, viewCount + 1);
  assert.equal(h.lastView(), undefined);

  await h.settle(ok("acct-1"), 1);
  assert.equal(h.views.length, viewCount + 1);
  assert.equal(h.runtime.view(), undefined);
  assert.equal(h.pendingTimers().length, 0);
});

// Extension wiring: load probe and mode/provider guards, without any network.

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => {};
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options);
    },
  };
  return { pi, handlers, commands };
}

function fakeCtx(mode: string, provider?: string) {
  const status: Array<[string, string | undefined]> = [];
  const notes: string[] = [];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      setStatus: (key: string, text: string | undefined) => status.push([key, text]),
      notify: (message: string) => notes.push(message),
    },
    modelRegistry: { getProviderAuth: async () => undefined },
    model: provider === undefined ? undefined : { provider },
  };
  return { ctx, status, notes };
}

/** Replaces the global fetch so any accidental request fails loudly instead of leaving the machine. */
function noNetwork() {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("network access is not allowed in tests");
  }) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("loading and registering the extension does no work", () => {
  const net = noNetwork();
  try {
    const { pi, handlers, commands } = fakePi();

    extension(pi as never);

    assert.deepEqual([...handlers.keys()].sort(), ["model_select", "session_shutdown", "session_start"]);
    assert.deepEqual([...commands.keys()], ["sub"]);
    assert.equal(net.calls(), 0);
  } finally {
    net.restore();
  }
});

test("non-TUI sessions produce no polling, no status and no notifications at all", async () => {
  const net = noNetwork();
  try {
    for (const mode of ["rpc", "json", "print"]) {
      const { pi, handlers, commands } = fakePi();
      extension(pi as never);

      const session = fakeCtx(mode, "openai-codex");
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, session.ctx);
      await handlers.get("model_select")?.({ type: "model_select", model: { provider: "openai-codex" } }, session.ctx);
      assert.deepEqual(session.status, []);
      assert.deepEqual(session.notes, []);

      const command = fakeCtx(mode, "openai-codex");
      for (const args of ["", "refresh", "nonsense"]) {
        await commands.get("sub")?.handler(args, command.ctx);
      }
      assert.deepEqual(command.notes, []);
      assert.deepEqual(command.status, []);

      await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, session.ctx);
      assert.deepEqual(session.status, []);
      assert.equal(net.calls(), 0);
    }
  } finally {
    net.restore();
  }
});

test("an unsupported provider in the TUI clears the status and queries nothing", async () => {
  const net = noNetwork();
  try {
    const { pi, handlers, commands } = fakePi();
    extension(pi as never);

    const session = fakeCtx("tui", "anthropic");
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, session.ctx);
    assert.deepEqual(session.status, [["pi-sub", undefined]]);
    assert.equal(net.calls(), 0);

    const command = fakeCtx("tui", "anthropic");
    for (const args of ["", "refresh", "nonsense"]) {
      await commands.get("sub")?.handler(args, command.ctx);
    }
    assert.deepEqual(command.notes, [
      "pi-sub: no supported provider active",
      "pi-sub: no supported provider active",
      "pi-sub: usage is /sub or /sub refresh",
    ]);
    assert.equal(net.calls(), 0);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, session.ctx);
    assert.deepEqual(session.status, [
      ["pi-sub", undefined],
      ["pi-sub", undefined],
    ]);
    assert.equal(net.calls(), 0);
  } finally {
    net.restore();
  }
});
