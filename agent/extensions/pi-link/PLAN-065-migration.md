# Plan: Pi 0.65.0 Migration

## Context

Pi 0.65.0 removes `session_switch` and `session_fork` events. All session transitions (startup, reload, /new, /resume, /fork) now fire `session_start` with `event.reason`. Each transition tears down the old runtime via `session_shutdown` before creating a fresh one.

This means our `session_switch` handler's in-place logic (cwd diffing, hub rename, client reconnect) is dead — by the time `session_start` fires, the old sockets, role, and live state are gone.

## Breaking change

```
Removed: pi.on("session_switch", ...)
Added:   pi.on("session_start", (event, ctx) => { event.reason: "startup" | "reload" | "new" | "resume" | "fork" })
```

---

## Batch 1 — Delete dead code

### Delete `session_switch` handler

The entire handler (cwd change detection, hub rename matrix, client reconnect) is dead under 0.65. All its paths assumed a live connection that no longer exists across session transitions.

### Delete `cwd_update` protocol path

With `session_switch` gone, `pushCwdUpdate()` has no caller. The incremental cwd update feature is dead code.

Remove:

- `CwdUpdateMsg` interface
- `CwdUpdateMsg` from `LinkMessage` union
- `pushCwdUpdate()` helper
- `case "cwd_update"` in `handleIncoming`
- `if (msg.type === "cwd_update")` relay block in `hubHandleClient`

**Cwd feature still works** through:

- `register.cwd` — sent on every fresh connect
- `welcome.cwds` — snapshot on join
- `terminal_joined.cwd` — broadcast to existing terminals

These all fire naturally when `initialize()` → `connectAsClient()` runs in the new runtime.

---

## Batch 2 — Persist connection intent

### New session entry: `link-active`

Same pattern as existing `link-name` entries.

**`/link-connect`:**

```ts
pi.appendEntry("link-active", { active: true });
```

**`/link-disconnect`:**

```ts
pi.appendEntry("link-active", { active: false });
```

### Intent resolution (used in `session_start`)

```ts
function shouldConnect(): boolean {
  const saved = ctx.sessionManager
    .getEntries()
    .filter((e) => e.type === "custom" && e.customType === "link-active")
    .pop() as { data?: { active?: boolean } } | undefined;

  if (saved?.data?.active !== undefined) return saved.data.active;
  return pi.getFlag("link") === true;
}
```

Precedence:

1. Last explicit `link-active` session entry wins (user intent)
2. Fall back to `--link` flag (default)

This means:

- `/link-connect` survives `/resume`, `/fork`, `/reload` (same session entries)
- `/link-disconnect` survives `/resume`, `/fork`, `/reload`
- `/new` starts fresh (no entries) — falls back to `--link` flag
- `--link` flag never overrides explicit user intent

**Behavior change:** A saved `link-active: true` now causes reconnect on startup into that session, even without `--link`. This is intentional — explicit session intent overrides the flag default. If a user previously did `/link-connect` in a saved session, resuming that session will reconnect automatically. This follows the "user intent wins" principle.

### `manuallyDisconnected` stays runtime-only

Not persisted. Starts fresh each runtime. Its only job is suppressing auto-reconnect within a single runtime after the user explicitly disconnects.

### `/link-disconnect` must work even when already disconnected

Current code has an early return when `role === "disconnected"`. Under the new model, that's wrong — the user may be disconnected but retrying (reconnect timer pending), or may want to persist `link-active: false` to prevent reconnect on next session_start.

New behavior:

```ts
handler: async (_args, _ctx) => {
  pi.appendEntry("link-active", { active: false });
  manuallyDisconnected = true;
  if (role === "disconnected") {
    // Still cancel any pending reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    _ctx.ui.notify("Link disconnected (intent saved)", "info");
    return;
  }
  disconnect();
  _ctx.ui.notify("Disconnected from link", "info");
};
```

---

## Batch 3 — Merge into unified `session_start`

### Delete old `session_start` handler

### New unified handler

```ts
pi.on("session_start", async (event, _ctx) => {
  ctx = _ctx;
  currentCwd = _ctx.cwd;

  // Restore preferred link name from session
  const saved = _ctx.sessionManager
    .getEntries()
    .filter((e) => e.type === "custom" && e.customType === "link-name")
    .pop() as { data?: { name?: string } } | undefined;
  if (saved?.data?.name) {
    preferredName = saved.data.name;
    terminalName = preferredName;
  }

  // Connect if session intent or --link flag says to
  if (shouldConnect()) await initialize();
});
```

No branching on `event.reason`. Same logic for all reasons. All fresh-runtime reconnects, including hub promotion fallback, flow through the existing `initialize()` connect-or-promote logic unchanged.

Logic:

1. Set `ctx`
2. Set `currentCwd`
3. Restore preferred name
4. Resolve connection intent → maybe `initialize()`

### `session_shutdown` stays as-is

Already calls `cleanup()`, which tears down everything correctly.

---

## Summary of changes

### Deleted

- `session_switch` handler (~75 lines)
- `pushCwdUpdate()` helper (~7 lines)
- `CwdUpdateMsg` interface (~4 lines)
- `CwdUpdateMsg` from `LinkMessage` union
- `cwd_update` case in `handleIncoming` (~3 lines)
- `cwd_update` relay block in `hubHandleClient` (~12 lines)

### Added

- `shouldConnect()` helper (~6 lines)
- `link-active` session entry persistence in `/link-connect` and `/link-disconnect`

### Modified

- `session_start` handler: merged, uses `shouldConnect()`

### Net change

~100 lines deleted, ~15 lines added. File gets shorter.

---

## Files changed

- `index.ts` — all changes above
- `README.md` — remove `cwd_update` from protocol docs, update message count (10 → 9), remove mid-session cwd update wording
- `TEST.md` — remove/rewrite session-switch and cwd-update-specific scenarios
- `docs/pi-link-agents-guide.md` + `skills/pi-link-coordination/SKILL.md` — no change needed (they don't reference cwd_update)

## Risk

Low-medium. The migration simplifies the code. Main risk is behavioral: ensuring manual `/link-connect` intent persists correctly across session transitions.

## Testing

- Scenario: Start with `--link` → connected on startup
- Scenario: Start without `--link` → disconnected on startup
- Scenario: `/link-connect` then `/reload` → reconnects (persisted intent)
- Scenario: `/link-disconnect` then `/reload` → stays disconnected (persisted intent)
- Scenario: `/link-connect` then `/new` → disconnected (fresh session, no entries, no `--link`)
- Scenario: `/link-connect` then `/resume` back → reconnects (entries preserved)
- Scenario: `--link` flag + `/link-disconnect` then `/reload` → stays disconnected (explicit intent wins)
- Scenario: Cwd changes across `/resume` → other terminals see new cwd via fresh register
