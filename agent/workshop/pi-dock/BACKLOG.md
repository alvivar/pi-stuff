# pi-dock — backlog

Everything not yet built. Contracts live in `DESIGN.md`. Delete an item when it ships.
Ordered by how much each item improves pi-dock. Updated 2026-10-01 after vega's field report
(vlab-1947, dguide-2003 and tetris-2256 experiments: resident teams driven only through the
CLI, coordinating over pi-link).

## Backlog, in priority order

1. [ ] **README: watchdog recipe for truly unattended runs** — there are no limits by design;
       unattended safety is external, not a budget in pi-dock. Recipe: an explicit roster
       saved before launching, an absolute deadline, a watchdog independent of the
       orchestrator calling `pi-dock stop`, failures of stop logged, no automatic escalation
       to killing a possibly reused PID. Honest: stop can be slow or fail, and a watchdog on
       the same machine cannot guarantee the deadline if the host sleeps or crashes. No new
       primitive needed.
2. [ ] **Extension-registered providers** in `models` and spawn/set preflight — today both
       use a bare `ModelRuntime`, so providers registered by extensions are not visible and
       spawn/set can reject a valid model. A correctness gap, but only for setups with
       extension providers.
3. [ ] **Validate a successful compaction in real use** — the paid smoke and the experiments
       only saw `compact` refuse (busy, session too small). Never observed in practice: a
       successful compaction, the `compacting` state, and memory surviving it. Needs a
       session large enough; paid, only with authorization.
4. [ ] **Unix runtime test** — Unix paths (socket, signals, stale-socket probe) are inspected
       only; run regression (and the smoke, with authorization) on Linux/macOS once. Matters
       as soon as pi-dock runs outside Windows.
5. [ ] **ls uptime** — time since the current runner booted (latest `spawned`), next to age.
       Low: in practice `logs` (`spawned` pid) and `show` were enough to tell restarts apart.

## Release — only if pi-dock is going to be used by others

6. [ ] **Publish** — `package.json` has `"private": true` (npm refuses to publish), no
       `description`; not pushed.

## Ideas — need design before building

- `fork`.

## Not needed (from real use)

- A native "follow until pattern" or `wait <name>` without id: a team's conclusion is an
  application fact, and "idle" is not stable with callbacks. A small observer polling
  `logs --raw` for a structured `text` marker is the right tool; recipe material, not a
  primitive.

## Watch

- `bin/pi-dock.mjs` is ~860 lines, much of it help text. Fine today; split the help out only
  if it keeps growing.
