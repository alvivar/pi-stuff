# Plan: `--link-name` Flag + Session Resume by Name

## Problem

Users want `pi --link-name worker-1` to:

1. Connect to the link with terminal name "worker-1"
2. Resume a session named "worker-1" if it exists, create a new one if not

Pi's `--session` only resolves by file path or UUID prefix, not by display name.
Extensions can't control session selection (it happens before `session_start`).

## Solution: Startup Re-exec Shim

When `--link-name <name>` is detected in `session_start`, **before writing any
session entries**, scan sessions for a matching name. If a match exists and the
current session is different, re-exec Pi with `--session <matched-path>` and
shut down the current process.

### Flow

```
pi --link-name worker-1
  │
  ├─ session_start fires (Pi already created a default new session)
  │
  ├─ Parse --link-name flag → "worker-1"
  │
  ├─ Guard checks (skip re-exec if any fail):
  │   ├─ PI_LINK_REEXEC env not set
  │   ├─ No explicit --session in process.argv
  │   ├─ No --resume, --fork, --no-session, --continue in process.argv
  │   └─ No --session-dir in process.argv (custom dir not supported)
  │
  ├─ Scan all session buckets, filter by cwd match from session header
  │   ├─ 0 matches → proceed normally (first session with this name)
  │   ├─ 1 match, same as current session → proceed normally (already correct)
  │   ├─ 1 match, different session → RE-EXEC
  │   └─ 2+ matches → print candidates, shut down (ambiguous)
  │
  ├─ RE-EXEC path:
  │   ├─ Build args: --session <path> + cleaned original argv
  │   ├─ Spawn pi with stdio:"inherit", env PI_LINK_REEXEC=1
  │   ├─ ctx.shutdown() to exit current process
  │   └─ Fallback: setTimeout(() => process.exit(0), 750).unref()
  │
  └─ NORMAL path (no re-exec):
      ├─ pi.appendEntry("link-name", { name })
      ├─ pi.setSessionName(name) if blank
      └─ scheduleStartupConnect()
```

### Critical rule: re-exec before any writes

In `session_start`, order must be:

1. Parse `--link-name`
2. If flag present, run re-exec decision (scan, compare, maybe re-exec)
3. Only AFTER re-exec is ruled out:
   - `pi.appendEntry(...)`
   - `pi.setSessionName(...)`
   - `scheduleStartupConnect()`

### Why no orphan session file

`SessionManager.create()` assigns a file path but only writes to disk on
first `appendEntry`. Since re-exec happens BEFORE any `pi.appendEntry()` or
`pi.setSessionName()`, the throwaway session is never flushed.

### Arg reconstruction

Walk `process.argv.slice(2)` with explicit index-based parsing (no regex).

Strip session-selection flags:
- Value flags: `--session <v>`, `--session=<v>`, `--fork <v>`, `--fork=<v>`,
  `--session-dir <v>`, `--session-dir=<v>`
- Boolean flags: `--continue`, `-c`, `--resume`, `-r`, `--no-session`

Prepend `--session <matched-path>`. Keep everything else (`--link-name`,
`--link-name=<v>`, `--model`, `--thinking`, `--tools`, prompt args, etc.).

### Session scanning

Scan all session buckets under `~/.pi/agent/sessions/`, but filter by
matching `cwd` from the session header against `_ctx.cwd`. This avoids
reimplementing Pi's cwd-to-directory encoding (which could diverge) while
keeping results scoped to the current project.

Cross-directory lookup remains `pi-link start`'s job.

### Path comparison

Use a helper for normalized comparison:

```ts
function samePath(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const ar = path.resolve(a);
  const br = path.resolve(b);
  return process.platform === "win32"
    ? ar.toLowerCase() === br.toLowerCase()
    : ar === br;
}
```

## `pi-link start` Wrapper (Layer 2)

`bin/pi-link.mjs` remains for cross-directory session lookup.

Changes needed:
- **Pass `PI_LINK_REEXEC=1` in env** — prevents the extension from re-scanning
  what the wrapper already resolved.

With the re-exec shim, `pi-link start` is still useful for:
- Cross-directory session resume (scans all session buckets globally)
- Explicit session disambiguation (prints candidates on multiple matches)
- Extra Pi flag passthrough with name-based lookup

But it's no longer the ONLY way to get session resume. `pi --link-name` is
now self-sufficient for the common case (same directory).

## Edge Cases

### `pi --session <path> --link-name worker-1`
Skip re-exec (explicit `--session` wins). Still set link name, persist, connect.

### `pi --continue --link-name worker-1`
Skip re-exec (`--continue` is an explicit session-selection policy). Resume
most recent session, set link name on it, connect.

### `pi --no-session --link-name worker-1`
Skip re-exec. Works as runtime-only link name. Session persistence is
meaningless with `--no-session`.

### `PI_LINK_REEXEC=1` but mismatch still detected
Warn. Do NOT re-exec again. Do NOT persist the name (don't create another
duplicate). Allow link connect with the name as runtime-only.

### 2+ cwd-local matches
Print candidates (modified time, path) and shut down. Do not name the
current session — that would create yet another duplicate.

## Risks & Mitigations

### Terminal handoff (highest risk)
Parent Pi's TUI is already running when `session_start` fires. Child Pi will
draw to the same terminal.

**Mitigation:** `ctx.shutdown()` for graceful teardown, plus fallback
`setTimeout(() => process.exit(0), 750).unref()`. Start without
`detached: true` on spawn — add only if testing shows child dies with parent.
Test on Windows.

### Path comparison on Windows
**Mitigation:** `samePath()` helper with `path.resolve()` + `.toLowerCase()`.

### Custom `--session-dir`
Our scan uses the default sessions directory. Custom dir would be wrong.
**Mitigation:** Skip re-exec entirely when `--session-dir` is in argv.

### Other extensions writing entries
Another extension could `appendEntry` in `session_start` before pi-link,
creating the throwaway session file.
**Mitigation:** Acceptable — abandoned file, not pi-link's problem.

### Env guard loop prevention
`PI_LINK_REEXEC=1` prevents infinite loops. On guard hit with mismatch:
warn, skip naming, connect as runtime-only.

## Session Data Structure

Sessions stored at: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"C:\\..."}
{"type":"session_info","name":"worker-1","id":"...","timestamp":"..."}
```

- Session name = last `session_info` entry's `name` field
- Cwd = `session` header's `cwd` field (used for filtering, not directory name)

## Key Pi APIs

- `pi.registerFlag(name, { type, description, default })` — register custom CLI flag
- `pi.getFlag(name)` — read flag value
- `pi.setSessionName(name)` — set session display name
- `pi.getSessionName()` — get current session name
- `ctx.shutdown()` — request graceful shutdown from session_start context
- `ctx.sessionManager.getSessionFile()` — current session file path
- `--session <path|id>` — Pi built-in: resume specific session
- `--continue` / `-c` — Pi built-in: resume most recent session in cwd

## Design Decisions

- **Re-exec before writing** — no orphan session file, no state pollution
- **Scan all buckets, filter by cwd** — safer than reimplementing cwd encoding
- **Exact name match only** — less surprising than prefix/fuzzy
- **Ambiguity = print candidates + shut down** — don't create another duplicate
- **Skip re-exec on any explicit session flag** — user's explicit choice wins
- **Env guard** — cheap infinite loop prevention; on hit, skip naming too
- **`--link-name` implies `--link`** — no need for both flags
- **Session name set only if blank** — don't overwrite existing names
- **`pi-link start` passes `PI_LINK_REEXEC=1`** — no double scanning
- **No `detached: true` initially** — add only if tests require it
- **Shutdown fallback timer** — 750ms, only on re-exec path

## Implementation Status

1. ~~`--link-name` flag registration~~ ✅ Done
2. ~~`pi-link start` wrapper CLI~~ ✅ Done
3. ~~Startup stale-context bug fix~~ ✅ Done
4. [ ] **Re-exec shim in `session_start`** — scan sessions, re-exec on mismatch
5. [ ] **`pi-link start` passes `PI_LINK_REEXEC=1`** in spawn env
6. [ ] Test: terminal handoff on Windows
7. [ ] Test: orphan file prevention
8. [ ] Test: env guard loop prevention
9. [ ] Test: `--session` + `--link-name` combo (no re-exec)
10. [ ] Test: 2+ matches → candidates + shutdown
11. [ ] Update README, CHANGELOG

## Bug Found & Fixed During Testing

**Stale extension context crash on startup auto-connect.**

Pi invalidates the extension context shortly after `session_start` returns. WebSocket
callbacks (message, open, close) that fire after invalidation would crash on `ctx.ui`
access, killing the process.

Pre-existing bug affecting all auto-connect paths (`--link`, `--link-name`, saved
`link-active` entries). Previously masked because users connected via `/link-connect`
(post-startup, with a fresh command context).

**Fix (3 parts):**

1. **Deferred connect**: `scheduleStartupConnect()` uses `setTimeout(0)` so Pi's
   startup cycle completes before WebSocket work begins.
2. **Safe context helpers**: `getUi()`, `notify()`, `isRuntimeLive()` — probe context
   validity without crashing. `isRuntimeLive()` guards all WebSocket message callbacks
   before calling `handleIncoming()`. `ctx.isIdle()` in `flushInbox()` wrapped in
   try/catch (bail without retry on stale context).
3. **Lifecycle guards**: `disposed` checks on all 7 WebSocket callback sites (client
   open/message/close, hub server listening/connection, hub client message/close).
   `ctx = undefined` in `cleanup()` to turn late access into no-ops.
