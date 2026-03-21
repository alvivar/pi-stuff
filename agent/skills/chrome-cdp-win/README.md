# chrome-cdp-win

A Windows-only fork of [`pi-chrome-cdp`](https://github.com/pasky/chrome-cdp-skill).
Every command works the same — this just makes them actually work on Windows.

## Prerequisites

- **Windows only** — on Linux/macOS use the [original extension](https://github.com/pasky/chrome-cdp-skill)
- Node.js 22+ (built-in WebSocket)
- Chrome with remote debugging on (`chrome://inspect/#remote-debugging`)

For usage and commands, see [SKILL.md](SKILL.md).

## Why fork instead of patch

The original extension uses Unix domain sockets for daemon IPC. On Windows
that fails immediately. A quick cross-platform patch (`IS_WIN` ternaries) got
daemons starting, but daemon discovery, cleanup, stop, and screenshot paths
were still wired to Unix conventions. Bolting on more platform branches made
the code harder to follow than just writing a clean Windows version.

## What's different for users

- Everything after `list` actually works (discovery, stop, cleanup were broken)
- Screenshots land in `%TEMP%\screenshot.png` by default
- Dead targets fail in ~1.5s instead of making you wait 30s
- Screenshots and snapshots get 30s to finish (heavy pages were timing out at 15s)
- `list` exits cleanly — no more 100ms sleep hack

## How it works

**Finding daemons** — each daemon drops a small JSON marker file in `%TEMP%`
(`cdp-daemon-<targetId>.json`). Named pipes live in kernel space and you can't
list them from Node, so the marker stores the pipe path. To check if a daemon
is still alive, we just try connecting to its pipe with a 2s timeout — simpler
and more reliable than checking PIDs. Stale markers get cleaned up in parallel
on every run.

**Starting safely** — the marker file is written inside the `server.listen()`
callback, so the pipe is guaranteed to be ready before anyone else can see it.
A `registered` flag makes sure the exit handler never accidentally deletes
another daemon's marker if two daemons race on the same pipe.

**Staying alive** — `runDaemon` returns a promise that never resolves. Without
that trick, the `process.exit(0)` at the end of `main()` would kill the daemon
right after setup. On the flip side, `getOrStartTabDaemon` watches for early
child death during the connect loop, so you get a clear error in ~1.5s instead
of waiting 30s for a daemon that's already gone.

**Commands** — a single dispatch `Map` maps command names and aliases to
handlers. `CDP.send` takes an optional per-call timeout so heavy operations
like screenshots and accessibility trees get 30s instead of the 15s default.
