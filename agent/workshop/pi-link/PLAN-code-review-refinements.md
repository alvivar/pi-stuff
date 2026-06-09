# PLAN — Code Review Refinements (index.ts)

Consolidated from two independent reviews (opus + gpt) of `index.ts` (1894 lines).
Tests green at review time: `node test/cli-flags-test.mjs` → 40/40.

**Nature:** one genuine correctness defect (#1); everything else removes verified
duplication or wasted work. Both reviewers agree on the refinements and on **not**
abstracting the RPC pending-request machinery (see "Explicitly out of scope").

Line numbers are approximate (pre-change); re-locate by the anchors given.

---

## #1 — Hub `close` handler uses stale captured name (DEFECT)

**Where:** hub client `close` handler, ~915–934 (inside `hubHandleClient`).

**Problem:** the handler closes over `clientName`. A `close` event that fires
_after_ `disconnect()` has already cleared `hubClients` and closed sockets still
runs the full body — mutating `connectedTerminals`, calling `updateStatus()`, and
`hubBroadcast`-ing a stale `terminal_left` (→ spurious "X left the link" while
disconnected; `connectedTerminals` drifts to `[hubName]`). Self-heals on reconnect,
but it's a real stale-event bug.

**Fix:** read from live state instead of the captured name. `disconnect()` empties
`hubClients`, so a stale event short-circuits.

```ts
clientWs.on("close", () => {
  if (disposed) return;
  const name = hubClients.get(clientWs);
  if (!name) return; // already removed (e.g. via disconnect) — ignore stale event
  hubClients.delete(clientWs);
  hubTerminalStatuses.delete(name);
  hubTerminalContexts.delete(name);
  hubTerminalCwds.delete(name);
  const list = terminalList();
  connectedTerminals = list;
  updateStatus();
  hubBroadcast({ type: "terminal_left", name, terminals: list }, name);
});
```

(Drops the `if (clientName)` wrapper — `hubClients.get` is the authoritative guard.)

**Risk:** low. **Verify:** client drop still broadcasts `terminal_left` once;
manual `/link-disconnect` on a hub emits no post-disconnect "left" notifications.

---

## #2 — `pushStatus` computes context it discards (perf/readability)

**Where:** `pushStatus`, ~268–283.

**Problem:** `captureContext()` runs _before_ the kind/tool dedupe early-return.
Dedupe keys only on `kind`/`tool`, so every no-op push (`tool_execution_start`/
`end`, `agent_end`, …) calls `ctx.getContextUsage()` and throws the result away.

**Fix:** move the capture below the early-return.

```ts
function pushStatus(force = false) {
  if (role === "disconnected") return;
  const status = deriveStatus();
  const newKind = status.kind;
  const newTool = status.kind === "tool" ? status.toolName : null;
  if (!force && newKind === lastPushedKind && newTool === lastPushedTool)
    return;
  lastPushedKind = newKind;
  lastPushedTool = newTool;
  const context = captureContext(); // only when we actually push
  const msg: StatusUpdateMsg = {
    type: "status_update",
    name: terminalName,
    status,
    context: context ?? null,
  };
  // ...unchanged
}
```

**Risk:** none (behavior-identical — context only ever ships alongside a status push).

---

## #3 — `normalizeName` helper (dup + consistency)

**Where (reads/saves of link/session names):** ~1173, 1182, 1206, 1225, 1747,
and the `/link-name` command (savePreference + no-arg path, ~1744–1767).

**Problem:** `.trim().replace(/\s+/g, " ")` repeated 5×, **and applied
inconsistently** — startup collapses internal whitespace, `/link-name` only
`.trim()`s, saved names load raw. A double-spaced name can be saved one way and
compared another.

**Fix:** one helper near the other small helpers; use it at every name read/save.

```ts
function normalizeName(name: string | undefined | null): string | undefined {
  const n = name?.trim().replace(/\s+/g, " ");
  return n ? n : undefined;
}
```

Apply to: `--link-name` flag value, `PI_LINK_NAME` env, saved `link-name` compare,
session-name fallbacks (both `session_start` and `/link-name`), and the
`/link-name` argument before save/compare.

**Risk:** low–medium (normalizes a few paths that previously didn't). **Verify:**
`test/cli-flags-test.mjs`; a `/link-name "a   b"` saves/compares as `"a b"`.

---

## #4 — `latestCustomData` helper for session-entry scans (dup)

**Where:** `shouldConnect` (~414, `link-active`), flag branch (~1195, `link-name`,
manual reverse-loop), else branch (~1215, `link-name`, `filter().pop()`).

**Problem:** "latest custom entry of type X" implemented two ways; `filter().pop()`
allocates a throwaway array.

**Fix:** single reverse-scan-with-break helper; don't over-genericize.

```ts
function latestCustomData(
  customType: string,
): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as {
      type: string;
      customType?: string;
      data?: Record<string, unknown>;
    };
    if (e.type === "custom" && e.customType === customType) return e.data;
  }
  return undefined;
}
```

Rewrite the three call sites in terms of it (read `.active` / `.name` with the same
type guards they use today).

**Risk:** medium — touches `session_start` **name-precedence** logic. Keep behavior
identical (last-matching wins, same guards). **Verify:** `test/cli-flags-test.mjs`

- manual precedence check (flag > env > saved > session > random).

---

## #5 — `targetNotFound` guard (dup)

**Where:** byte-identical block in `link_send` (~1347), `link_compact` (~1428),
`link_prompt` (~1537).

**Fix:** one guard helper; keeps the user-facing string/details consistent.

```ts
function targetNotFound(to: string) {
  return connectedTerminals.includes(to)
    ? null
    : textResult(
        `Terminal "${to}" not found. Connected: ${connectedTerminals.join(", ")}`,
        {
          to,
          error: "not_found",
        },
      );
}
```

Use as `const miss = targetNotFound(params.to); if (miss) return miss;`
(in `link_send`, keep the existing `params.to !== "*"` wrapper). Self-checks differ
by message — leave inline.

**Risk:** none (behavior-identical).

---

## #6 — `renderIconResult` helper (nit, dup)

**Where:** `link_send` (~1388–99) and `link_compact` (~1500–11) `renderResult` are
byte-identical (`link_prompt`'s is intentionally richer — leave it).

**Fix:** shared renderer near the other tool helpers.

```ts
function renderIconResult(
  result: {
    content: { type: string; text?: string }[];
    details?: Record<string, unknown>;
  },
  theme: Theme,
) {
  const txt = result.content[0];
  const details = result.details as Record<string, unknown> | undefined;
  const icon = details?.error
    ? theme.fg("error", "✗ ")
    : theme.fg("success", "✓ ");
  return new Text(icon + (txt?.type === "text" ? txt.text : ""), 0, 0);
}
```

Both tools' `renderResult` become `(result, _options, theme) => renderIconResult(result, theme)`.
(Use the existing `Theme` type import if available; else inline the param type.)

**Risk:** none.

---

## #7 — `CompactResponseMsg.reason` comment (nit)

**Where:** ~112.

**Fix:** the `finish(false, "unsupported")` path emits `unsupported`, which the
comment omits.

```ts
reason?: string; // "busy" | "not_found" | "unsupported" | error text; absent on success
```

**Risk:** none (comment only).

---

## Explicitly out of scope — do NOT abstract the RPC pending machinery

Both reviewers independently agree: `link_prompt` and `link_compact` share a
prologue + Promise/abort/not-delivered shape, but differ enough that a generic
`awaitRemote()` is net-negative:

- `link_prompt`: inactivity timeout reset by status updates + 30 min hard ceiling
  (two timers, `resetInactivityFor`) + text/error response.
- `link_compact`: single flat 180 s timeout + `ok/reason` response + compact-specific
  busy/unsupported/not_found semantics.
- Different cleanup text, result details, routing edge cases.

A generic await-RPC layer would need so many parameters it'd be as complex as the
duplication and would hide debugging-relevant behavior. The targeted helpers (#3,
#5) capture the cheap wins instead.

---

## Suggested sequencing

1. **Pass A (low-risk, behavior-identical):** #2, #5, #6, #7. Bundle-check.
2. **Pass B (consistency win):** #3 `normalizeName`. Run `test/cli-flags-test.mjs`.
3. **Defect fix:** #1 hub `close` guard. Manual disconnect/reconnect check.
4. **Pass C (sensitive):** #4 `latestCustomData`. Run tests + name-precedence check.

**Verify after each pass:** esbuild bundle check
(`npx --yes esbuild index.ts --bundle --platform=node --format=esm
--external:@earendil-works/* --external:ws --external:typebox --external:node:*
--outfile=/tmp/pi-link-check.mjs`) and `node test/cli-flags-test.mjs`.
