# PLAN — Link status endpoint + `pi-link --status`

Expose live link state (connected terminals, busy/idle, context usage) to the
shell for automation. Owner-approved design (2026-06-09): **option D** — a
plain HTTP `GET /status` served by the hub on the existing link port, consumed
by a new `pi-link --status [--json]` mode (and by anything else: `curl`, CI
scripts, watchers).

Spans both `index.ts` (hub) and `bin/pi-link.mjs` (CLI) — deliberately kept
separate from `PLAN-cli-hardening.md`, which stays small and executable as-is.

## Decisions

**Resolved (owner, 2026-06-09):**

- **Option D over alternatives.** A (wire query message) costs a new protocol
  type + `ws` dep in the CLI and is curl-hostile. B (register-then-leave)
  needs no hub change but spams joined/left notifications — wrong for polling.
  C (status file) trades one problem for three (staleness, churn, crash
  detection). D makes link state a queryable local service.
- **Snapshot-only.** No `--watch`/streaming; pollers call repeatedly.
- **Context usage included** in the payload (`tokens`/`window`) — it's the
  field automation needs to decide when to `link_compact`.
- **JSON schema is a contract** — field names freeze once shipped; README
  documents it.

**Conventions (no sign-off needed):**

- Endpoint path: `GET /status`. Anything else on the port that isn't a WS
  upgrade → 404. No CORS headers (shell automation, not browsers — revisit
  only on demand).
- CLI honors `PI_LINK_PORT` env as a port override, **default 9900, primarily
  a test hook** (lets the suite run a stub hub on a free port). Undocumented
  in README until the extension honors it too (out of scope here).
- Exit codes: `0` link up · `2` no hub running (connection refused/timeout) ·
  `1` usage error or version skew. Makes `pi-link --status --json >/dev/null`
  a clean "is the link up?" probe.

---

## #1 — Hub: serve `GET /status` on the link port (index.ts)

**Where:** `startHub` (~L965), hub teardown (wherever `wss.close()` happens),
new `handleStatusRequest` helper near the hub section.

**The wrinkle (verified):** `new WebSocketServer({ port, host })` creates an
internal HTTP server that ws does not expose; plain HTTP requests get a
hardwired 426. Serving `/status` requires owning the server:

```ts
import { createServer } from "node:http"; // type-only cost; bundles clean

const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(buildStatusPayload()));
  } else {
    res.writeHead(404);
    res.end();
  }
});
const server = new WebSocketServer({ server: httpServer });
httpServer.listen(DEFAULT_PORT, "127.0.0.1");
```

**Refactor invariants (the actual risk — hub bootstrap):**

- `"listening"` / `"error"` events move from the wss to `httpServer`; the
  EADDRINUSE → `resolve(false)` → fall-back-to-client path **must keep
  working** (this is how hub election works).
- Teardown: `wss.close()` does **not** close an externally-provided HTTP
  server — keep an `httpServer` ref and close both in every path that closes
  the wss today (dispose, `/link-disconnect`, listening-after-dispose race).
- No other hub logic changes; `/status` reads existing state, mutates nothing.

**Payload (`buildStatusPayload`)** — assembled from what `link_list` already
uses: `deriveStatus()` + `currentCwd` + `captureContext()` for the hub itself,
`hubTerminalStatuses` / `hubTerminalCwds` / `hubTerminalContexts` for clients.
Hub first, then clients sorted by name (deterministic output):

```json
{
  "hub": "archon@pi-link",
  "port": 9900,
  "terminals": [
    {
      "name": "fable@pi-link",
      "role": "hub",
      "status": "idle",
      "sinceSeconds": 420,
      "cwd": "C:/Users/andre/.pi",
      "context": { "tokens": 92000, "window": 1000000 }
    }
  ]
}
```

- `status`: `"idle"` | `"thinking"` | `"tool:<name>"` (flattened from
  `LinkStatus.kind`/`toolName`).
- `sinceSeconds`: `(Date.now() - status.since) / 1000`, rounded — relative, so
  pollers don't need clock agreement.
- `context`: `{ tokens, window }` from `ContextSnapshot`
  (`tokens` may be `null` mid-refresh, mirroring `?/272K` in `link_list`);
  `null` when no snapshot exists for that terminal.

**Risk:** moderate — confined to hub bootstrap/teardown; the endpoint itself
is read-only.
**Verify:** esbuild gate; post-install live check: two terminals still elect
hub/client correctly; `curl 127.0.0.1:9900/status` returns the payload; second
`pi --link` instance on the same port still falls back to client.

---

## #2 — CLI: `pi-link --status [--json]` (bin/pi-link.mjs)

**Where:** new exclusive mode alongside `--list`/`--resolve` (mode-selection
phase); fetch + render helpers near `listSessions`; `printHelp` usage lines.

**Behavior:**

- `--status` combines with nothing except `--json` (mirror `--list`'s
  combination rejections; positional args rejected). `-g` is meaningless here
  → "cannot combine".
- Fetch `http://127.0.0.1:${PI_LINK_PORT ?? 9900}/status` with
  `AbortSignal.timeout(2000)` (built-in fetch, Node 18+; no new deps).
- Outcomes:
  - 200 + valid JSON, `--json` → raw body to stdout, exit 0.
  - 200 + valid JSON, human mode → `renderTable` (NAME, STATUS, CONTEXT, CWD)
    matching `link_list`'s formats: `92K/1.0M (9%)`, `?/272K`, `idle (7m)`,
    `displayPath` for cwd.
  - Connection refused / timeout → stderr `No link hub running on :9900.`,
    exit 2.
  - Connects but non-JSON / 404 / 426 (old extension hub) → stderr
    `Link hub does not support /status — update pi-link and restart terminals.`,
    exit 1.

**Risk:** low — new isolated mode; parser surface covered by tests.
**Verify:** section J below; existing 40 cases stay green.

---

## #3 — Tests (section J, test/cli-flags-test.mjs)

Stub hub: ~10-line `http.createServer` started by the suite on an ephemeral
port (`listen(0)`), passed to the CLI via `PI_LINK_PORT`. No real hub, no ws.

| #   | Case                                                     | Asserts                                        |
| --- | -------------------------------------------------------- | ---------------------------------------------- |
| J1  | `--status --json` against stub serving a fixture payload | exit 0; stdout parses; expected fields present |
| J2  | `--status` (human) against same stub                     | exit 0; table contains terminal name + status  |
| J3  | `--status` with nothing listening on the port            | exit 2, "No link hub running"                  |
| J4  | Stub answering 404/non-JSON                              | exit 1, "does not support /status"             |
| J5  | `--status foo`                                           | exit 1 (does not accept arguments)             |
| J6  | `--status --list`                                        | exit 1, "cannot combine"                       |
| J7  | `--status -g`                                            | exit 1, "cannot combine"                       |

`tokens: null` rendering (`?/272K`) rides in J1/J2 fixture data.

---

## #4 — README

- CLI section: `--status [--json]` usage rows + one curl example.
- Short "Status endpoint" paragraph: the JSON schema (the frozen contract),
  exit codes, and the localhost-only note.
- SKILL.md untouched — in-Pi agents already have `link_list`; this is the
  shell-side equivalent.

---

## Explicitly out of scope

- Streaming / `--watch` / long-poll (decided snapshot-only).
- Port configurability beyond the CLI test hook (extension keeps fixed 9900).
- Auth / non-localhost exposure / CORS.
- Option A wire query type, option C status file.
- Version bump / CHANGELOG (handled by hand separately).

## Sequencing

1. **Pass A — #1 hub endpoint** (index.ts; the bootstrap refactor needs the
   most care). Gate: esbuild bundle clean.
2. **Pass B — #2 CLI mode + #3 tests** (independently testable via stub; can
   start in parallel with A). Gate: `node --check bin/pi-link.mjs` + full
   suite green (40 + J cases).
3. **Pass C — #4 README.**
4. **Post-ship live check** (after install + terminal restarts): hub election
   intact, `curl /status` works, `pi-link --status` against the real hub.

**Gate (mechanical, per pass):**

```
npx --yes esbuild index.ts --bundle --platform=node --format=esm \
  --external:@earendil-works/* --external:ws --external:typebox \
  --external:node:* --outfile=/tmp/pi-link-check.mjs
node --check bin/pi-link.mjs
node test/cli-flags-test.mjs
```
