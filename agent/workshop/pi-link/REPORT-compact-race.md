# REPORT — link_compact vs. local compaction race ("reading 'signal'" crash)

> **Status:** Report (historical evidence; Defect 2 mitigated in pi-link 0.3)
> **Last aligned:** 2026-08-25
> **Build from this?** No new pi-link work is pending here. Defect 1 remains upstream pi-core and is still present in 0.84.2 (`compact()` assigns `this._compactionAbortController` and then reads `.signal` non-optionally across async gaps, clearing the shared field in an unconditional `finally`). Defect 2 is mitigated in two steps: pi-link gates delivery and declines remote requests while a *manual* compaction it can see is running, and — since 0.3.0 — authorizes remote requests from Pi's own `ctx.isIdle()` instead of its view of the agent run, so the post-`agent_end` retry / automatic-compaction / queued-continuation window is closed too. What is **not** closed: a local manual `/compact` aborts, authorizes and prepares before Pi announces it, so a remote request landing in that window is still accepted. Only the core fix closes it.
> **Summary:** forensic report of a live compaction race, kept for its 0.79.1 evidence and line numbers, plus the mitigation that was built from it.

Observed live on 2026-06-11 during the orchestrate-code-pipeline run; reproducible
in principle. Two distinct defects, in two layers. pi-link's transport behaved
correctly throughout (exactly-one-callback contract held; the error was relayed
faithfully) — the earlier ledger note calling this a "pi-link transport bug" was
wrong.

Versions: pi-coding-agent **0.79.1**, pi-link **0.1.16**.

## Observed sequence (the evidence)

1. Owner manually compacted **all** pi terminals "to help out" right around the
   run's start.
2. Orchestrator pre-flight `link_list`: `gpt@pi-link 94K/272K`, `committer@.pi
   59K/272K` — these were **pre**-compaction numbers; the owner's compactions
   were still landing.
3. Orchestrator called `link_compact(gpt@pi-link)` →
   `Compact on "gpt@pi-link" not done: Cannot read properties of undefined (reading 'signal')`
4. Immediate retry → `Compact on "gpt@pi-link" not done: Already compacted`
5. Next `link_list`: gpt `?/272K` **and committer `?/272K`** — committer was
   never touched by any `link_compact`, proving a local/owner compaction landed
   on it during this window. gpt's first turn later reported 40K.

Step 5 is the key forensic detail: the owner's compact-all was racing the run.
The first `link_compact` arrived while gpt's **locally-initiated** compaction
was in flight (or interleaved with its teardown).

## Defect 1 — pi core: `session.compact()` is not reentrancy-safe

`dist/core/agent-session.js` (0.79.1):

- `compact()` sets `this._compactionAbortController = new AbortController()`
  near the top (after `await this.abort()` — an async gap), then reads
  `this._compactionAbortController.signal` **non-optionally** at three points,
  each after further async gaps:
  - L1296 — `session_before_compact` extension emit payload
  - L1319 — `await compact(..., this._compactionAbortController.signal, ...)`
  - L1325 — post-compaction `signal.aborted` check
- The **only** code that sets it back to `undefined` is `compact()`'s own
  `finally` (L1370).

So two overlapping `compact()` invocations interleave as: call A's `finally`
nulls the **shared instance field** while call B is suspended between its own
assignment and a later read → call B throws
`TypeError: Cannot read properties of undefined (reading 'signal')`.

The auto-compaction path has the same shape with its own field
(`_autoCompactionAbortController`: set L1475, non-optional reads ~L1527/L1557,
nulled in `finally` L1620), so manual-vs-auto and auto-vs-manual overlaps are
plausibly affected too, not just manual-vs-manual.

The clean `"Already compacted"` on retry (L1284) is correct behavior: by then
the branch tip was the owner's compaction entry and `prepareCompaction`
returned null.

### Suggested core fix (either suffices, both are better)
- Capture the controller in a local: `const controller = new AbortController();
  this._compactionAbortController = controller;` and read `controller.signal`
  throughout; `finally` clears the field only if it still `=== controller`.
- And/or an explicit reentrancy guard: throw `"Compaction already in progress"`
  at entry when a compaction is running (mirrors the existing
  "Already compacted" / "Nothing to compact" family).

## Defect 2 — pi-link: target-side busy guard is blind to local compactions

`index.ts` `compact_request` handler (~L716):

```ts
if (agentRunning || pendingRemotePrompt || compactRunning) { ...decline busy... }
```

- `compactRunning` is set **only** for remote-requested compactions.
- `agentRunning` tracks agent runs; a compaction is not an agent run.
- A **locally-initiated** compaction (user `/compact`, TUI command, or pi
  auto-compaction) is invisible to all three flags → pi-link accepts the
  remote request and calls `ctx.compact()` concurrently with the local one →
  triggers Defect 1.

### Suggested pi-link mitigation
Track local compaction state from session events and fold it into the guard:
- `session_before_compact` (fires for both manual and auto paths when handlers
  exist) → `localCompactRunning = true`
- `session_compact` (already handled at ~L1257) and/or compaction-end/error →
  `localCompactRunning = false`

Caveats to verify during implementation:
- `session_before_compact` fires mid-`compact()` (after abort/auth/prepare), so
  a remote request landing in the early window still races — this narrows the
  hole, only the core fix closes it.
- Confirm the extension event surface actually delivers a usable
  start/end pair in all paths (incl. failed compactions) so the flag can't
  stick; a stuck `localCompactRunning` would make the terminal permanently
  decline remote compacts.

## Repro sketch

- **Core-only (deterministic):** construct a session, fire two overlapping
  `session.compact()` calls (don't await the first); expect the second to throw
  the `'signal'` TypeError (or misbehave via the shared field).
- **Through pi-link (timing-dependent):** terminal A with a large session:
  start `/compact`; from terminal B immediately `link_compact(A)`. Expect
  `ok:false` with the TypeError message relayed as `reason`.

## Open questions

1. Which exact read threw in our incident (L1296 vs L1319 vs L1325) — needs a
   stack trace; the relayed message carries only `e.message`. A core fix makes
   the distinction moot.
2. Can auto-compaction race a remote compact in practice (auto fires near the
   context ceiling; remote compacts target busy-idle terminals — overlap is
   plausible on long autonomous runs).
3. Whether `session.abort()` inside `compact()` can abort a *running* local
   compaction and produce a different interleaving (abortCompaction aborts but
   does not null the controllers — looks safe, unverified).

## Disposition

- Defect 1 → upstream pi issue (core fix; this report has the evidence and
  line numbers). Unchanged in 0.84.2.
- Defect 2 → done in pi-link, in the two steps described in the status block:
  the manual-compaction gate, then idle-authoritative authorization plus the
  settled lifecycle in 0.3.0. The guard now declines unless Pi reports the
  session idle and no manual compaction holds the gate, which covers the local,
  remote and automatic compactions the original guard missed — every window except
  the one before Pi announces a local manual compaction, which stays open until
  Defect 1 is fixed. Open question 2 below is answered: automatic compaction can
  overlap a remote request, and that is exactly the window `ctx.isIdle()` closes.
- Bonus observation for SKILL.md accuracy: the skill's "(3 min ceiling …)" note
  remains correct — this race produces an immediate error, not a timeout. Its
  busy-decline wording was correct for the guard of the time and was rewritten in
  0.3.0, when the guard became "idle by Pi, and ungated".
