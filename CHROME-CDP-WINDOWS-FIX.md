# chrome-cdp Windows Fix: Unix Domain Sockets → Named Pipes

## Problem

The `pi-chrome-cdp` extension uses Unix domain sockets (`/tmp/cdp-<targetId>.sock`) for IPC between its daemon and client processes. On Windows, `net.Server.listen()` on Unix socket paths fails with `EACCES` (`errno -4092`), so the daemon can never start and every command after `list` (which only uses HTTP) fails with:

```
Daemon failed to start — did you click Allow in Chrome?
```

The real error (visible when running `_daemon` directly) is:

```
Error: listen EACCES: permission denied /tmp/cdp-<targetId>.sock
```

## Root Cause

Windows doesn't support Unix domain sockets at arbitrary filesystem paths the way Linux/macOS does. Node.js on Windows supports **named pipes** instead, using the `//./pipe/<name>` convention.

## Fix Applied

File: `node_modules/pi-chrome-cdp/skills/chrome-cdp/scripts/cdp.mjs`

### 1. Socket path — use named pipes on Windows

```diff
-const SOCK_PREFIX = '/tmp/cdp-';
-const PAGES_CACHE = '/tmp/cdp-pages.json';
-
-function sockPath(targetId) { return `${SOCK_PREFIX}${targetId}.sock`; }
+const IS_WIN = process.platform === 'win32';
+const SOCK_PREFIX = IS_WIN ? '//./pipe/cdp-' : '/tmp/cdp-';
+const PAGES_CACHE = IS_WIN ? (process.env.TEMP || process.env.TMP || '/tmp') + '/cdp-pages.json' : '/tmp/cdp-pages.json';
+
+function sockPath(targetId) { return IS_WIN ? `${SOCK_PREFIX}${targetId}` : `${SOCK_PREFIX}${targetId}.sock`; }
```

Named pipes (`//./pipe/cdp-<targetId>`) work correctly on Windows for `net.Server.listen()` and `net.connect()`.

### 2. Daemon connection timeout — increase retry window

The original 20 retries × 300ms = 6 seconds was too short for a user to click Chrome's "Allow debugging" dialog. Increased to 60 × 500ms = 30 seconds:

```diff
-const DAEMON_CONNECT_RETRIES = 20;
-const DAEMON_CONNECT_DELAY = 300;
+const DAEMON_CONNECT_RETRIES = 60;
+const DAEMON_CONNECT_DELAY = 500;
```

## Notes

- The `list` command was always fine because it only hits Chrome's HTTP endpoint (`localhost:9222/json`), not the WebSocket/daemon.
- The `.sock` suffix is omitted for named pipes since they don't use filesystem extensions.
- `PAGES_CACHE` was also updated to use `%TEMP%` on Windows instead of `/tmp/` (though `/tmp/` happened to resolve on this system, it's not reliable on all Windows setups).
- These changes should be contributed upstream to `pi-chrome-cdp` for proper Windows support.
