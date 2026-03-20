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
- [x] **PID recycling** — Pipe-connect is the liveness check. Dead daemon = dead pipe = instant `ENOENT`. PID stored in marker only for future `stop` force-kill (phase 2).
- [x] **Registry cleanup consolidation** — Single `await pruneStaleDaemons()` at top of `main()`.

## Remaining TODO

### Phase 2 — Graceful stop via PID

- [ ] **Force-kill hung daemons** — When `stop` can't reach a daemon's pipe but the per-daemon marker file has a PID, try `process.kill(pid)` before deleting the file. Prevents leaked processes.

### Phase 3 — Error messages

- [ ] **Friendly `getWsUrl()` errors** — Wrap with actionable messages:
  - `ENOENT` on DevToolsActivePort → "No Chromium browser found with remote debugging enabled. Open chrome://inspect/#remote-debugging and toggle the switch."
  - `ECONNREFUSED` on WebSocket → "Chrome is running but rejected the connection. Is another debugger already attached?"

### Phase 4 — Multi-browser support

- [ ] **Chrome profile paths** — Scan known `%LOCALAPPDATA%` paths in order:
  1. `Google\Chrome\User Data` (Chrome)
  2. `Microsoft\Edge\User Data` (Edge — pre-installed on all Windows)
  3. `Google\Chrome SxS\User Data` (Canary)
  4. `Google\Chrome Beta\User Data` (Beta)
  5. `BraveSoftware\Brave-Browser\User Data` (Brave)
  6. `Chromium\User Data` (Chromium)
  
  First one with a `DevToolsActivePort` file wins. Allow override via `CDP_USER_DATA_DIR` env var for custom `--user-data-dir` setups.
