# pi-dock — backlog

Everything not yet built. Contracts live in `DESIGN.md`. Delete an item when it ships.
Ordered by how much each item improves pi-dock (polaris review of 0.2.0, 2026-10-01 — to discuss).

## Backlog, in priority order

1. [ ] **F5 log external input** (audit) — the visibility gap for unattended agent-to-agent
       work (RV lab, pi-link). Content entering the session not via the pipe →
       `{event:"external", source, from}` without body, so the dock log stays the complete
       lifecycle record. Today such work shows as `turn`/`text` without id (or under the
       active run's id), with no sender: an agent-to-agent loop is visible only as repeated
       id-less turns, and reconstructing who wrote to whom means opening each session file.
       Convenience, not data loss — the session file has everything. Needs design first:
       find what the SDK exposes to detect extension-injected input generically, without
       pi-link knowledge in pi-dock.
2. [ ] **Extension-registered providers** in `models` and spawn/set preflight — today both
       use a bare `ModelRuntime`, so providers registered by extensions are not visible and
       spawn/set can reject a valid model. A correctness gap, but only for setups with
       extension providers.
3. [ ] **F7 bulk stop** — `stop --all` or by pattern (`rv-*`). Cheap, and stopping a lab of
       residents one by one is the common chore.
4. [ ] **Unix runtime test** — Unix paths (socket, signals, stale-socket probe) are inspected
       only; run regression (and the smoke, with authorization) on Linux/macOS once. Matters
       as soon as pi-dock runs outside Windows.
5. [ ] **ls uptime** — time since the current runner booted (latest `spawned`), next to age.
       Nice to have.

## Release — only if pi-dock is going to be used by others

6. [ ] **CHANGELOG** for `0.2.0`.
7. [ ] **Publish** — `package.json` has `"private": true` (npm refuses to publish); not pushed.
8. [ ] **`docs/pi-dock.html`** — outdated (still describes the budget, among others); owner
       updates it.

## Ideas — need design before building

- `fork`.

## Watch

- `bin/pi-dock.mjs` is ~860 lines, much of it help text. Fine today; split the help out only
  if it keeps growing.
