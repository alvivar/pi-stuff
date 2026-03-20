# chrome-cdp-win — TODO (Windows-only focus)

## Origin

Forked from `pi-chrome-cdp` (npm package) which had a partial Windows fix applied:

- ✅ Named pipes (`//./pipe/cdp-<targetId>`) instead of Unix sockets for daemon IPC
- ✅ `%TEMP%` for `PAGES_CACHE` instead of `/tmp/`
- ✅ Increased daemon connection timeout (60×500ms = 30s)

But left several things broken on Windows:

- ❌ `listDaemonSockets()` scanned `/tmp` for `.sock` files — couldn't find named pipes
- ❌ `stop` command couldn't discover or stop any daemons
- ❌ `findAnyDaemonSocket()` couldn't reuse existing daemons for `list`
- ❌ Default screenshot path hardcoded to `/tmp/screenshot.png`
- ❌ `unlinkSync(daemon.socketPath)` as cleanup — no-op on named pipes
- ❌ Help text still referenced Unix sockets and `/tmp`

## What this fork fixed

| Area                     | Fix                                                                       |
| ------------------------ | ------------------------------------------------------------------------- |
| Daemon discovery         | Per-daemon marker files `%TEMP%/cdp-daemon-<targetId>.json`               |
| Daemon lifecycle         | `registerDaemon()` writes marker, `unregisterDaemon()` deletes it         |
| Stale daemon cleanup     | `pruneStaleDaemons()` checks pipe liveness via `net.connect`, not PID     |
| Crash cleanup            | `process.on('exit')` handler calls `unregisterDaemon()` (sync `unlinkSync`) |
| No races                 | Each daemon writes only its own file — no shared state                    |
| No PID recycling issue   | Liveness = pipe connect, not `process.kill(pid, 0)`                       |
| Prune consolidation      | Single `await pruneStaleDaemons()` at top of `main()`, not scattered      |
| `stop` command           | Finds daemons via marker files, removes when unreachable                  |
| Screenshot default       | `%TEMP%/screenshot.png`                                                   |
| `getWsUrl()`             | Windows-only: `%LOCALAPPDATA%/Google/Chrome/User Data/DevToolsActivePort` |
| Help text                | References named pipes and `%TEMP%` paths                                 |
| Cross-platform branching | Removed — this is a Windows-only fork                                     |

## Completed phases

### Phase 1 ✅ — Per-daemon files + pipe-based liveness

Replaced shared `cdp-daemons.json` with per-daemon marker files and pipe-connect liveness.

- [x] **Registry file races** — Each daemon writes only its own file. Zero contention.
- [x] **Daemon crash without cleanup** — `process.on('exit')` does best-effort `unlinkSync`. Stale files pruned on next CLI run via pipe-connect check.
- [x] **PID recycling** — Pipe-connect is the liveness check. Dead daemon = dead pipe = instant `ENOENT`. PID stored in marker only for `stop` force-kill.
- [x] **Registry cleanup consolidation** — Single `await pruneStaleDaemons()` at top of `main()`.

### Phase 2 ✅ — Graceful stop via PID

- [x] **Force-kill hung daemons** — When `stop` can't reach a daemon's pipe, `process.kill(pid)` is attempted before removing the marker file. Prevents leaked processes.

### Phase 3 ✅ — Error messages

- [x] **Friendly `getWsUrl()` errors** — `ENOENT` on DevToolsActivePort gives actionable hint. `ECONNREFUSED` on WebSocket connect caught in both daemon and `list` direct-connect paths.

### Phase 4 — Skipped

Multi-browser support (Edge, Brave, Canary, Chromium) not needed — Chrome-only use case.
