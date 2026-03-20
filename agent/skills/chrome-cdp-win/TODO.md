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
| Daemon discovery         | Registry file at `%TEMP%/cdp-daemons.json` instead of filesystem scan     |
| Daemon lifecycle         | `registerDaemon()` on start, `unregisterDaemon()` on shutdown             |
| Stale daemon cleanup     | `pruneStaleDaemons()` checks PID liveness via `process.kill(pid, 0)`      |
| `stop` command           | Finds daemons via registry, removes entry when unreachable                |
| Screenshot default       | `%TEMP%/screenshot.png`                                                   |
| `getWsUrl()`             | Windows-only: `%LOCALAPPDATA%/Google/Chrome/User Data/DevToolsActivePort` |
| Help text                | References named pipes and `%TEMP%` paths                                 |
| Cross-platform branching | Removed — this is a Windows-only fork                                     |

## Remaining TODO

### Phase 1 — Per-daemon files + pipe-based liveness (solves 4 items)

Replace single shared `cdp-daemons.json` with one file per daemon: `%TEMP%/cdp-daemon-<targetId>.json`.
Each contains `{ "pipePath": "//./pipe/cdp-<targetId>", "pid": <number>, "startedAt": <epoch> }`.

Replace `process.kill(pid, 0)` PID liveness check with pipe-connect liveness check:
`net.connect(pipePath)` with a short timeout — if the pipe is gone, the daemon is dead.

Keep PID in the file only as a fallback for `stop` (to force-kill hung daemons in phase 2).

This resolves:

- [ ] **Registry file races** — Each daemon writes only its own file. No read-modify-write on shared state. Zero contention.
- [ ] **Daemon crash without cleanup** — Stale per-daemon file is harmless. Next `prune` tries the pipe, fails, deletes the file. No corrupted shared state. Add `process.on('exit')` as best-effort cleanup (synchronous `unlinkSync` works on regular files, unlike named pipes).
- [ ] **PID recycling** — Pipe-connect is the liveness check. When a daemon dies, Windows destroys the named pipe immediately. `net.connect` gives `ENOENT`. No PID involved, no recycling problem.
- [ ] **Registry cleanup consolidation** — `pruneStaleDaemons()` becomes: glob `%TEMP%/cdp-daemon-*.json`, try pipe-connect on each, delete stale files. One call at top of `main()`.

### Phase 2 — Graceful stop via PID

- [ ] **Force-kill hung daemons** — When `stop` can't reach a daemon's pipe but the per-daemon file has a PID, try `process.kill(pid)` before deleting the file. Prevents leaked processes.

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
