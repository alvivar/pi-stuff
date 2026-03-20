# chrome-cdp-win — TODO

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

| Area | Fix |
|------|-----|
| Daemon discovery | Registry file at `%TEMP%/cdp-daemons.json` instead of filesystem scan |
| Daemon lifecycle | `registerDaemon()` on start, `unregisterDaemon()` on shutdown |
| Stale daemon cleanup | `pruneStaleDaemons()` checks PID liveness via `process.kill(pid, 0)` |
| `stop` command | Finds daemons via registry, removes entry when unreachable |
| Screenshot default | `%TEMP%/screenshot.png` |
| `getWsUrl()` | Windows-only: `%LOCALAPPDATA%/Google/Chrome/User Data/DevToolsActivePort` |
| Help text | References named pipes and `%TEMP%` paths |
| Cross-platform branching | Removed — this is a Windows-only fork |

## Remaining TODO

### High priority

- [ ] **Test end-to-end** — Verify `list`, `snap`, `eval`, `shot`, `stop` all work with the registry-based daemon discovery
- [ ] **Registry file races** — Multiple daemon processes read/write `cdp-daemons.json` concurrently. Needs file locking or atomic writes (rename-over) to prevent corruption
- [ ] **Daemon crash without cleanup** — If a daemon crashes (unhandled exception, `process.exit(1)` in error paths), `unregisterDaemon()` is never called. `pruneStaleDaemons()` handles stale PIDs but the PID could be recycled by a different process
- [ ] **Chrome profile paths** — Only supports default Chrome install at `%LOCALAPPDATA%/Google/Chrome/User Data/`. Doesn't handle Chrome Beta, Canary, Chromium, Edge, Brave, or custom `--user-data-dir`

### Medium priority

- [ ] **PID recycling** — `process.kill(pid, 0)` can return true for a completely unrelated process that reused the PID. Store `startedAt` timestamp in registry (already there) and cross-check with process start time, or store a nonce and verify on connect
- [ ] **Graceful stop via PID** — When a daemon pipe is unreachable but PID is alive, try `process.kill(pid, 'SIGTERM')` before just removing from registry
- [ ] **Screenshot path in SKILL.md** — The `shot` command docs say `%TEMP%/screenshot.png` but the skill tells the agent `[file]` is optional. Make sure the agent knows the actual default path so it can read the file back
- [ ] **Error messages** — Some errors (e.g. `DevToolsActivePort` not found) give cryptic `ENOENT` messages. Add user-friendly hints like "Is Chrome running with remote debugging enabled?"

### Low priority

- [ ] **Support Edge/Brave/Chromium** — Detect `DevToolsActivePort` from other Chromium browsers' user data dirs
- [ ] **Config file** — Allow overriding Chrome user data dir, default screenshot path, timeouts
- [ ] **Registry cleanup on `list`** — Currently `pruneStaleDaemons()` is called in several places but not exhaustively. Consider a single entry point
- [ ] **Upstream contribution** — If these changes prove stable, contribute the registry-based approach back to `pi-chrome-cdp` behind a platform check so the main package works cleanly on all platforms
