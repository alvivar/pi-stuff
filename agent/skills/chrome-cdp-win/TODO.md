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

---

## Code Review Findings

### Bugs

1. **`process.on('exit')` can delete another daemon's marker file** (L537)
   The exit handler is registered *before* `registerDaemon()` and calls `unregisterDaemon(targetId)` unconditionally. If `server.listen()` fails with EADDRINUSE (race: two clients spawn daemons for the same tab simultaneously), the process exits without ever calling `registerDaemon` — but the exit handler still runs and deletes the *other* daemon's marker file. Fix: track a `registered` flag, only unregister if we registered.

2. **No `server.on('error')` handler in `runDaemon`** (L654)
   If `server.listen(sp)` fails (e.g. EADDRINUSE), Node emits an unhandled `'error'` event on the server, which crashes the process. The exit handler then triggers bug #1. Fix: add `server.on('error', (e) => { process.exit(1); })` — the exit handler (once fixed with the flag) will skip unregister.

3. **`sendCommand` has no timeout** (L680)
   If the daemon hangs mid-command, `sendCommand` waits forever. The CLI process never exits. Fix: add a `setTimeout` that rejects the promise (30s default, matching `NAVIGATION_TIMEOUT`).

### Simplicity

4. **`shotStr` DPR detection is a 3-layer cake** (L323–340)
   Three attempts: `Page.getLayoutMetrics` with manual viewport division, then `Emulation.getDeviceMetricsOverride` (which fails if no emulation is set — it almost always fails), then `window.devicePixelRatio` via eval. The JS eval is the only one that reliably works. Replace with just `window.devicePixelRatio`.

5. **`stopDaemons` has duplicated logic** (L738–763)
   The targeted (`if targetPrefix`) and broadcast (`for` loop) branches are nearly identical. Deduplicate: filter the list first, then one `for` loop.
   ```js
   const targets = targetPrefix
     ? [daemons.find(d => d.targetId === resolvePrefix(...))]
     : daemons;
   for (const daemon of targets) { ... }
   ```

6. **`sendCommand` registers 4 event handlers with manual cleanup** (L680–728)
   `onEnd` and `onClose` produce identical errors. The `settled` flag + `cleanup()` pattern is verbose. Could use `conn.once()` for `error`/`end` and simplify.

7. **`pruneStaleDaemons` returns a value nobody uses** (L101–112)
   It returns the array of live entries, but both call sites (`main()` and the old implicit one) ignore the return value. Either make it `void` or use the return value to avoid the redundant `listDaemonEntries()` + `findAnyDaemonSocket()` calls later.

8. **`defaultScreenshotPath` declared at module level only for the USAGE string** (L771)
   The same path is recomputed inside `shotStr` (L345). Use the module-level constant in both places.

9. **`setTimeout(() => process.exit(0), 100)` in list** (L859)
   Hack to flush stdout before exit. Idiomatic fix: `process.stdout.write(text, () => process.exit(0))` or just remove it — `main()` returns and the event loop drains naturally.

### Performance

10. **`listDaemonEntries` reads the entire `%TEMP%` directory** (L79)
    `readdirSync(TEMP_DIR)` on Windows `%TEMP%` can return thousands of entries. Then we `.filter()` for our prefix. Not a problem today, but could use `readdirSync(TEMP_DIR, { withFileTypes: true })` and filter on `isFile()` first, or better: use `globSync` (Node 22+) to only match `cdp-daemon-*.json`.

11. **`getOrStartTabDaemon` can't detect early daemon death** (L660–674)
    If the daemon crashes immediately (e.g. attach fails, Chrome closed), we still poll for 30 seconds. Fix: keep the `child` ChildProcess reference, listen for `'exit'`, and reject early.

12. **`evalStr` calls `Runtime.enable` on every invocation** (L311)
    This is called on every `eval`, `html`, `waitForDocumentReady`, `loadall`, `net`, and `shotStr` (DPR fallback). `Runtime.enable` is idempotent but it's a round-trip per call. Call it once in `runDaemon` after attach.

### Idiomatic JS/ESM

13. **`checkPipeLive` parameter `resolve` shadows the `path.resolve` import** (L92)
    The Promise constructor's `resolve` parameter shadows the top-level `import { resolve } from 'path'`. Works, but confusing. Rename to `res` or `done`.

14. **`NEEDS_TARGET` duplicates command names from `handleCommand` switch** (L815)
    Three places list command names: `NEEDS_TARGET`, `handleCommand` switch, and `USAGE`. Adding a command requires updating all three. Consider deriving `NEEDS_TARGET` from a command dispatch table that also serves `handleCommand`.

15. **`CDP.send` hardcodes `TIMEOUT` for all methods** (L173)
    `Accessibility.getFullAXTree` on heavy pages can exceed 15s. `Page.captureScreenshot` likewise. No way to pass a per-call timeout. Add an optional `timeout` parameter to `send()`.

### Not worth fixing

- `writeFileSync` for `PAGES_CACHE` — fine for a CLI tool, not a server.
- Synchronous file reads in `listDaemonEntries` `.map()` — handful of files, negligible.
- `orderedAxChildren` dual-source merging — correctly handles Chrome's inconsistent AX tree. Complex but necessary.

---

## Fix Plan

### Batch A ✅ — Daemon safety (bugs #1, #2, #3)

All three bugs interact: #2 triggers #1, and #3 is the other daemon-client reliability gap.

- [x] **A1: `registered` flag in `runDaemon`** — Exit handler only unregisters if
  `registered === true`. Set after `registerDaemon()` in `server.listen` callback.
- [x] **A2: `server.on('error')` handler** — Logs error, closes CDP, exits.
  Exit handler safe because `registered` is still false.
- [x] **A3: `sendCommand` timeout + simplification** — 30s default timeout (matches
  `NAVIGATION_TIMEOUT`). Simplified from 4 handlers + `settled` flag + `cleanup()` to
  single `settle()` helper + `removeAllListeners()`. Merged `onEnd`/`onClose`.

**Tested:**
- A1+A2: Spawned second `_daemon` for same targetId → EADDRINUSE, exited cleanly,
  original daemon's marker file intact, original daemon still responded to commands.
- A3: Connected to a pipe server that never responds → timed out after ~3s with
  descriptive error message.

### Batch B ✅ — Simplify command plumbing (findings #4, #5, #7, #8, #14)

- [x] **B1: Simplify `shotStr` DPR** — Deleted `Page.getLayoutMetrics` and
  `Emulation.getDeviceMetricsOverride` attempts. Uses only `window.devicePixelRatio`.
- [x] **B2: Deduplicate `stopDaemons`** — Filter-then-loop, one `for` block.
- [x] **B3: Use `pruneStaleDaemons` return value** — `main()` stores `liveDaemons`,
  reuses for `list` socket and target resolution. Removed `findAnyDaemonSocket()`.
- [x] **B4: `DEFAULT_SCREENSHOT_PATH` constant** — Single module-level constant
  used in both `shotStr` and USAGE string.
- [x] **B5: Command dispatch table** — `handleCommand` uses a `Map` of
  `{ handler, needsTarget }` entries. Aliases share the same entry.
  `NEEDS_TARGET` kept as static Set for `main()` (runs before daemon) with
  a comment linking it to the dispatch table.

### Batch C ✅ — Client-side robustness (findings #9, #11, #13)

- [x] **C1: Clean process exit** — Replaced `setTimeout(exit, 100)` hack with
  `main().then(() => process.exit(0))`. Fixed `conn.end()` → `conn.destroy()` in
  `sendCommand` and `checkPipeLive` to release socket handles. Added
  `return new Promise(() => {})` in `runDaemon` so daemon mode isn't killed
  by the `.then()` handler.
- [x] **C2: Early daemon death detection** — `getOrStartTabDaemon` listens for
  child `'exit'` event. If daemon dies during poll loop, rejects immediately
  (~1.5s) instead of waiting 30s.
- [x] **C3 (bonus): `resolve` shadow fixed** — `checkPipeLive` Promise parameter
  renamed to `res` (finding #13).

### Batch D — Low-risk cleanups (findings #12, #13, #15)

Small independent changes with no interaction. Can be done in any order.

- [ ] **D1: `Runtime.enable` once after attach** — Move from `evalStr` to `runDaemon`,
  right after `attachToTarget` succeeds. Remove from `evalStr`.
- [ ] **D2: Rename `resolve` → `res` in `checkPipeLive`** — One-line rename to avoid
  shadowing `path.resolve`.
- [ ] **D3: Optional timeout parameter on `CDP.send`** — Add `timeout = TIMEOUT` as
  4th parameter. Pass longer timeouts from `snapshotStr` and `shotStr`.

**How to test:**
- D1: Run `eval`, `html`, `net`, `loadall`, `shot` — all should still work (Runtime was
  already enabled by the daemon at attach time).
- D2: Syntax check only.
- D3: Test with a heavy page where `snap` previously timed out at 15s.

### Finding #10 — `readdirSync(TEMP_DIR)` performance

Deferred. `%TEMP%` has hundreds of files, not millions. `globSync` would help but isn't
worth the churn right now. Revisit if profiling shows it's a bottleneck.
