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

### High priority

- [ ] **Registry file races** — Multiple daemon processes read/write `cdp-daemons.json` concurrently with plain `readFileSync`/`writeFileSync`. Two daemons starting at the same time can clobber each other's entries. Fix: atomic writes via write-to-temp + rename-over (`fs.renameSync` is atomic on NTFS).
- [ ] **Daemon crash without cleanup** — If a daemon crashes (unhandled exception, `process.exit(1)` in error paths before `shutdown()`), `unregisterDaemon()` is never called. `pruneStaleDaemons()` catches this via PID check, but only when the next CLI invocation happens to call it. Add a top-level `process.on('uncaughtException')` and `process.on('exit')` handler in the daemon to always unregister.
- [ ] **PID recycling** — `process.kill(pid, 0)` can return true for a completely unrelated process that reused the PID. The registry already stores `startedAt` — cross-check with the actual process creation time (via `wmic process where ProcessId=<pid> get CreationDate`), or better: attempt a pipe connect as the liveness check instead of PID. If the pipe doesn't respond to a ping, the daemon is dead regardless of what PID says.

### Medium priority

- [ ] **Graceful stop via PID** — When a daemon pipe is unreachable but PID is alive (hung daemon), try `process.kill(pid)` before just removing from registry. Currently a hung daemon leaks the process.
- [ ] **Chrome profile paths** — Only supports default Chrome at `%LOCALAPPDATA%\Google\Chrome\User Data\`. Doesn't handle Chrome Beta (`Chrome Beta`), Canary (`Chrome SxS`), Chromium, Edge (`Microsoft\Edge\User Data`), Brave (`BraveSoftware\Brave-Browser\User Data`), or custom `--user-data-dir`. At minimum detect Edge since it's pre-installed on every Windows machine.
- [ ] **Error messages** — `getWsUrl()` throws a raw `ENOENT` when `DevToolsActivePort` doesn't exist. Wrap with: "Chrome DevToolsActivePort not found. Is Chrome running? Enable remote debugging at chrome://inspect/#remote-debugging".

### Low priority

- [ ] **Registry cleanup consolidation** — `pruneStaleDaemons()` is called in `findAnyDaemonSocket()`, `stopDaemons()`, `list`, and `main()` target resolution — four separate call sites. Consider a single entry point early in `main()` so it runs once per CLI invocation.
