# pi-dock — backlog

Everything not yet built. Contracts live in `DESIGN.md`. Delete an item when it ships.
Ordered by how much each item improves pi-dock. Updated 2026-10-01 after vega's field report
(vlab-1947, dguide-2003 and tetris-2256 experiments: resident teams driven only through the
CLI, coordinating over pi-link).

## Backlog, in priority order

1. [ ] **Skill: two operating facts** — from real use, both implicit today:
       - a `done` of an initial mission does not end a collaboration: extension callbacks
         (e.g. pi-link replies) can start later work, so a team's conclusion is an
         application signal (an agreed final marker in a `text` event, then verify the
         artifact), never `done` or idle;
       - `wait` printing nothing means the run's last turn wrote no text; read `logs`.
         Semantics stay: returning the last non-empty text would hide that fact.
2. [ ] **`stop <name>...`** (replaces F7 bulk stop) — several explicit names, no `--all` and no
       patterns (the shell expands; a wrong pattern on stop is expensive). Validate the
       syntax of the whole list before acting, so a malformed last name cannot cause a
       surprising partial power-off; then stop each, continue past an operational failure,
       print one line per name, exit 1 if any failed. No transaction or rollback.
3. [ ] **F5 external input, generic** — extension-injected work shows today as `turn`/`text`
       without id (or under the active run's id), so the dock log tells *that* an agent
       worked, not *what started it*. Log `{event:"external", type}` with the extension's
       message type, no body and no sender: "from" would need pi-link's schema in pi-dock.
       It is a hint ("an extension started this"), not a receipt — vega's S3 case still
       needed the session to see which message arrived and why the agent acted as it did.
       Needs design first: find the SDK hook that sees extension-injected messages
       generically; decide whether it records the injection request or the message actually
       entering the session; it may land during an active run, not only before an id-less
       `turn`. If it needs pi-link knowledge or broker emulation, drop it and document a
       diagnostic recipe pointing to `show` → session file instead.
4. [ ] **README: watchdog recipe for truly unattended runs** — there are no limits by design;
       unattended safety is external, not a budget in pi-dock. Recipe: an explicit roster
       saved before launching, an absolute deadline, a watchdog independent of the
       orchestrator calling `pi-dock stop`, failures of stop logged, no automatic escalation
       to killing a possibly reused PID. Honest: stop can be slow or fail, and a watchdog on
       the same machine cannot guarantee the deadline if the host sleeps or crashes. No new
       primitive needed.
5. [ ] **Extension-registered providers** in `models` and spawn/set preflight — today both
       use a bare `ModelRuntime`, so providers registered by extensions are not visible and
       spawn/set can reject a valid model. A correctness gap, but only for setups with
       extension providers.
6. [ ] **Validate a successful compaction in real use** — the paid smoke and the experiments
       only saw `compact` refuse (busy, session too small). Never observed in practice: a
       successful compaction, the `compacting` state, and memory surviving it. Needs a
       session large enough; paid, only with authorization.
7. [ ] **Unix runtime test** — Unix paths (socket, signals, stale-socket probe) are inspected
       only; run regression (and the smoke, with authorization) on Linux/macOS once. Matters
       as soon as pi-dock runs outside Windows.
8. [ ] **ls uptime** — time since the current runner booted (latest `spawned`), next to age.
       Low: in practice `logs` (`spawned` pid) and `show` were enough to tell restarts apart.

## Release — only if pi-dock is going to be used by others

9. [ ] **Publish** — `package.json` has `"private": true` (npm refuses to publish), no
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
