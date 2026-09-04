# PLAN — Live link status: hub `GET /status` + `pi-link --status`

> **Status:** Executable — owner-approved 2026-08-28 (design iterated with owner; supersedes
> the archived `PLAN-cli-status.md`, re-derived from first principles against the current
> C2-ownership codebase).
> **Version target:** 0.4.0 (new surface + frozen JSON contract → minor, owner-confirmed).
> **Baseline:** pi-link 0.3.0 published; branch `master` (the 0.3.0 refactor branch was
> merged; `85a80bd` is an ancestor), repo HEAD `9250882` — intervening commits are
> unrelated projects, pi-link subtree unchanged. Canonical suite 195/195 verified at this
> baseline (2026-08-28).
> **Gate (per task):** see each task; canonical suite = `node test/cli-flags-test.mjs` +
> `node test/lifecycle-compact-test.mjs` + `node test/connection-ownership-test.mjs` +
> `node test/inbox-fixed-window-test.mjs`, plus esbuild bundle check and
> `node --check bin/pi-link.mjs`.

## Problem

With a fleet of terminals there is no way to see from outside Pi who is connected to the
hub right now. `pi-link --list` reads session history on disk — a session dead for days and
a live-but-idle one look identical — and the only live read today is registering over
WebSocket, which inserts a ghost terminal and announces join/leave to the whole fleet.
Observation contaminates the observed. (GitHub issue: ~18-terminal fleet, repeated
misinventory; reporter's `probe:true` mechanism was evaluated and rejected — see
"Rejected alternatives".)

## Design (all decisions resolved with owner)

**Hub side:** the hub answers plain HTTP `GET /status` on the port it already owns
(127.0.0.1:9900). Read-only: the payload is assembled from the same state `link_list`
already uses; it mutates nothing and never enters the WS protocol. Any other
method/path → 404. No CORS, no auth (trusted-localhost, same trust boundary as the
existing WS surface — any local process can already register and receive `welcome`).

**CLI side:** new exclusive mode `pi-link --status [--json]`. No new dependencies
(global `fetch`). Human mode renders a table; `--json` writes the response body verbatim
to stdout.

### Payload (frozen contract)

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
      "context": { "tokens": 92000, "window": 272000 }
    }
  ]
}
```

- Hub entry first, then clients sorted by name (deterministic output).
- `status`: `"idle" | "thinking" | "compacting" | "tool:<name>"` — flattened from
  `LinkStatus`. **`compacting` is a required member** (post-0.3.0 state; the archived
  plan predates it).
- `sinceSeconds`: `Math.round((Date.now() - status.since) / 1000)` — relative, so pollers
  need no clock agreement.
- `cwd`: present when known, omitted when not.
- `context`: `{ tokens, window }`; `tokens` may be `null` mid-refresh (mirrors `?/272K`);
  the whole field is `null` when no snapshot exists.
- **Contract clause (README):** documented fields are frozen; consumers must tolerate
  unknown fields. This is the growth escape hatch — nothing is pre-reserved (no
  `sessionId` until something consumes it; the register handler already ignores unknown
  fields, so adding it later is compatible by construction).

### CLI behavior

- `--status` combines only with `--json`; positional args and `-g` rejected
  ("cannot combine" / "does not accept arguments"), mirroring `--list`'s parser rules.
- Fetch `http://127.0.0.1:${PI_LINK_PORT ?? 9900}/status` with `AbortSignal.timeout(2000)`.
- Human table: NAME / STATUS / CONTEXT / CWD via the existing `renderTable`, formats
  matching `link_list`: `idle (7m)`, `92K/272K (34%)`, `?/272K` when tokens null,
  `displayPath` for cwd, blank/`?` for absent values.
- Exit codes (messages deliberately distinct — automation must distinguish them):
  - `0` — 200 + valid JSON.
  - `2` — connection refused / timeout: `No link hub running on :<port>.`
    (interpolate the effective port).
  - `1` — usage error, or connected-but-unsupported (426/404/non-JSON):
    `Link hub does not support /status — update pi-link and restart terminals.`
    A 0.3.0 hub answers plain HTTP with a hardwired 426 (verified in ws 8.21.3), so
    old-hub detection is deterministic, never conflated with "no hub".
- `PI_LINK_PORT` (env, CLI-only): read as `process.env.PI_LINK_PORT ?? 9900` at the
  fetch. One README line: it changes only where the CLI asks; the extension hub always
  binds 9900; it exists for tests. No validation — a garbage port fails the fetch and
  exits 2 with the port in the message, which is the diagnosis.

### Vocabulary

The snapshot proves "registered with the responding hub at capture time" — CONNECTED.
It does not prove process health. Never render LIVE/DEAD. `--list` is history, `--status`
is now; the README states which question each answers.

## Implementation facts (source-verified, ws 8.21.3)

These change the cost/risk picture vs the archived plan:

1. **Election machinery is untouched.** With `new WebSocketServer({ server })`, ws
   *forwards* `listening` and `error` from the provided HTTP server to the wss, and
   `wss.close()` still emits `close`. `startHub`'s existing handlers — including
   EADDRINUSE → `settle(false)` → fall-back-to-client, and the cancelled-pre-listen
   settle — keep working verbatim.
2. **The one real hazard: `wss.close()` never closes a provided HTTP server** (explicit
   branch in ws). A missed close leaves a zombie process squatting 127.0.0.1:9900
   machine-wide, silently breaking hub election for every terminal. Exactly three
   teardown sites exist, all already closing the wss; each adds one
   `httpServer.close()`:
   - `cancelConnectionAttempt` (attempt in flight),
   - `disconnect()` (established-wss branch),
   - `startHub`'s listening-while-not-current branch.
3. **Ownership:** `ConnectionAttempt` gains an `httpServer` handle owned by the attempt
   from construction (same settle/cancel discipline C2 established); a module-level hub
   HTTP server ref is nulled wherever `wss` is nulled. Pending → established in one step.
4. `buildStatusPayload()` is pure reads of `deriveStatus()` / `currentCwd` /
   `captureContext()` / `hubTerminal*` maps — single-threaded snapshot, no races.
5. Port sharing is clean by construction: the request handler fires only for non-upgrade
   requests; WS upgrades ride the forwarded `upgrade` path.

Estimated diff: ~45–60 lines in `index.ts` + the CLI mode + tests.

## Tasks

### T1 — Hub endpoint (`index.ts`) — SENSITIVE, fresh window

`createServer` handler (200 JSON on `GET /status`, else 404) +
`new WebSocketServer({ server })` + `listen(DEFAULT_PORT, "127.0.0.1")` in `startHub`;
`buildStatusPayload()`; the three `httpServer.close()` sites; attempt-owned handle per
fact 3. No other hub logic changes.

**Tests (same task):** extend the ownership/lifecycle harness the way it already
intercepts `ws` so `node:http` is stubbed too — **no test may bind a real port, ever**.
Cover: payload shape (hub-first ordering, all four statuses incl. `compacting`,
null-context, `sinceSeconds`), 404 on other paths, read-only (no state mutation, no
broadcasts, no `hubClients` change), and the three teardown sites each closing the HTTP
server (cancel mid-attempt / disconnect / listening-after-cancel), election fallback
still intact under EADDRINUSE.

**Gate:** esbuild bundle check + full canonical suite (old + new tests green).

### T2 — CLI mode + tests (`bin/pi-link.mjs`, `test/cli-flags-test.mjs`)

Parser: exclusive `--status` mode + `--json`; rejections per design. Fetch + render +
exit codes + `PI_LINK_PORT`. Help text.

**Tests (section J, stub HTTP server on ephemeral port via `PI_LINK_PORT`):**
J1 `--status --json` → exit 0, parses, fields present (fixture includes `tokens: null`
and a `compacting` terminal); J2 human table → exit 0, name+status rendered; J3 nothing
listening → exit 2, "No link hub running"; J4 stub answering 404/426/non-JSON → exit 1,
"does not support /status"; J5 `--status foo` → exit 1; J6 `--status --list` → exit 1
"cannot combine"; J7 `--status -g` → exit 1 "cannot combine"; J8 port interpolation in
the exit-2 message.

**Gate:** `node --check bin/pi-link.mjs` + full canonical suite.

### T3 — README

- CLI section: `--status [--json]` usage rows + one curl example.
- "Status endpoint" section: the frozen JSON schema, the tolerate-unknown-fields clause,
  exit codes with both distinct messages, localhost-only note.
- The two-questions framing: `--list` = saved history, `--status` = connected now;
  CONNECTED wording, no liveness claims.
- Promotion-window note: exit 2 means "no hub at this instant"; after a hub exits,
  promotion takes ~2–5 s (jittered) — re-poll before concluding the fleet is down.
- The one `PI_LINK_PORT` line.
- SKILL.md untouched (in-Pi agents already have `link_list`).

**Gate:** docs-only diff; `git diff --check` clean.

### T4 — Version + changelog (HOLD for owner GO regardless of autonomy)

`package.json` → 0.4.0; CHANGELOG entry (Added: status endpoint + CLI mode; note the
old-hub 426 → exit 1 behavior and the contract clause). Full suite re-run.

### Live gate (owner-run, after install + terminal restarts)

1. Two terminals elect hub/client normally; `curl 127.0.0.1:9900/status` returns the
   payload; `pi-link --status` renders it.
2. Second `pi --link` instance still falls back to client (election intact).
3. Kill the hub → after promotion, `/status` works on the new hub.
4. `/link-disconnect` on the hub → port 9900 actually freed (no zombie: a new terminal
   can become hub).
5. Old-hub check if convenient: 0.3.0 hub + new CLI → exit 1 with the update message.

## Rejected alternatives (recorded for the issue reply)

- `register + probe:true` — fail-dirty: a 0.3.0 hub ignores the unknown field and
  registers the probe, broadcasting join/leave to the fleet — amplifies the reported
  problem during any version skew.
- Dedicated pre-register WS query — fail-silent against old hubs (dropped unread;
  timeout indistinguishable from dead hub); needs a WS client in the CLI.
- Second port / ws private `_server` / status file / TCP preflight — strictly worse
  (second election surface / version-fragile / unfixable staleness / answers the wrong
  question).
- LIVE/DEAD column in `--list` — no truthful join without a session id on the wire
  (dedup suffixes like `builder-2` are never persisted); deferred until a `sessionId`
  is added end-to-end, and only as CONNECTED/UNKNOWN.

## Out of scope

Streaming/`--watch` (pollers repeat); auth/CORS/non-localhost; extension honoring
`PI_LINK_PORT`; `sessionId` anywhere; any `--list` change; GitHub issue reply (owner
handles at the end); publish/tag/push (owner-only).
