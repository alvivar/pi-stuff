# REPORT — Conditional use of `session_compact_failed` to release held messages

> **Status:** deferred candidate for a version after 0.3.0. **Not a 0.3.0 publication blocker.**
> **Build from this?** Not yet — only after focused harness proof, a source recheck against whatever Pi is current then, and a live two-terminal confirmation.
> **Last aligned:** Pi **0.84.3** (installed), pi-link **0.3.0** at HEAD `313f2313e97415ecd7541b10c9d404054dcd3acf`.
> **Summary:** Pi 0.84.3 adds a `session_compact_failed` extension event. **If a future implementation can first correlate a failure with the `session_before_compact` that raised the current gate**, pi-link could release held messages promptly instead of waiting for the next agent run, a later successful compaction, or the 180-second deadline.

## What pi-link does today

pi-link holds two independent flags (`index.ts:195-196`) and gates delivery on
either (`compactionGated()`, `index.ts:500-502`):

- **`localCompacting`** — the manual-compaction gate. It covers a human `/compact`
  **and** a remote `ctx.compact()`, because Pi's `compact()` hardcodes
  `reason: "manual"` for both (`agent-session.js:1403`, `:1426`), so a remote
  request raises this flag on top of `compactRunning`. Raised from
  `session_before_compact` when `event.reason === "manual"` (`index.ts:1360`).
- **`compactRunning`** — this terminal is compacting because a *remote* peer asked
  it to. Set synchronously before `ctx.compact()` is ever called.

While either is up, inbound messages are held rather than delivered, and
`link_compact` declines as busy. `releaseInbox()` drains only when **both** are
clear (`index.ts:534-538`).

The local gate has exactly three clearing paths today:

1. a successful `session_compact` (`index.ts:1363-1367`);
2. the terminal's next `agent_start` (`index.ts:1336`);
3. the `COMPACT_TIMEOUT_MS` deadline armed inside `setCompacting()`
   (`index.ts:553-560`) — 180 seconds.

So a manual compaction that **fails or is cancelled** leaves messages held until
one of those fallbacks fires. Nothing is lost — the sender is simply told nothing
and delivery waits. The wording shipped in `README.md:307` and in the public skill
remains **true of pi-link's behaviour today** and must not be changed by this
report.

## What Pi 0.84.3 adds

`session_compact_failed`, declared at `dist/core/extensions/types.d.ts:464-478`
with its handler overload at `:900`:

```ts
reason: "manual" | "threshold" | "overflow";
errorMessage?: string;   // absent when the compaction was aborted
aborted: boolean;        // true when cancelled or aborted
willRetry: boolean;
fromExtension: boolean;
```

### Ordering — the fact that makes this safe

From the manual `compact()` failure tail in
`dist/core/agent-session.js:1500-1521`, in this exact order:

1. `this._compactionAbortController = undefined;` — the controller is cleared **first**;
2. `this._emit({ type: "compaction_end", reason: "manual", aborted, willRetry: false, errorMessage })` — session listeners only;
3. `await this._emitSessionCompactFailed({ ... })` — the extension event, **awaited**;
4. `throw error;` — only now does the error propagate.

The extension handler therefore runs **after** Pi has released its compaction
controller and **before** the error reaches the caller. That matters: the reason
`index.ts:1349-1353` deliberately refuses to release on `event.signal` is that the
signal fires while the compaction controller is still alive, so releasing there
re-opens delivery mid-unwind. This event does not have that problem.

It also means that on a *remote* request the handler runs before `ctx.compact()`'s
`onError` (`index.ts:814-819`) surfaces the failure to pi-link's `finish(false, …)`
path. The wrapper confirms it: `agent-session.js:2001-2011` awaits `this.compact()`
and calls `onError` only in the `catch`, which is reached only after the awaited
failure event and the `throw`.

**Version pinning.** Every line number above is from installed Pi **0.84.3**.
They are not claims about any later release and must be rechecked before use.

### Ownership caveat — read this before designing a handler

**`reason === "manual"` does not prove the failing attempt owns the current
`localCompacting`.** Pi wraps the entire compaction body in one `try`, and four
failure classes throw *before* `session_before_compact` is ever emitted
(`agent-session.js:1400-1422`):

- no model selected (`:1406`);
- summarization auth failure (`:1409`);
- `Already compacted` (`:1417`);
- `Nothing to compact (session too small)` (`:1419`).

All four still land in the same `catch` and still emit
`session_compact_failed` with `reason: "manual"` — for an attempt that **never
raised pi-link's gate**. And the payload carries **no attempt id and no signal**
(`types.d.ts:464-478`: `reason`, `errorMessage?`, `aborted`, `willRetry`,
`fromExtension` — nothing else), so the event cannot be correlated to an attempt
from its own contents.

The concrete hazard starts in the still-open **pre-announcement** window: a remote
request can be accepted before a human `/compact` has emitted
`session_before_compact`. The two manual attempts can then overlap. If one attempt
raises the gate while the other fails before emitting its own
`session_before_compact` (for example during auth), a bare manual-reason handler
clears a gate the failing attempt never owned. Pi 0.84.3 supplies no event identity
to distinguish them.

**So this opportunity is conditional.** It depends on establishing serialization or
correlation on pi-link's side, or on an upstream guarantee of attempt identity or
non-reentrancy. **A bare manual-reason handler is not safe and must not be
written.**

## Semantics and boundaries

- **React only to `reason === "manual"`.** pi-link gates only manual compaction;
  threshold and overflow compaction run inside an unsettled agent run and are
  deliberately not delivery-gated (`index.ts:1343-1347`). A handler that cleared
  the local gate on those reasons would clear a flag it never set.
- **`fromExtension` does not mean "pi-link asked for this".** It is set true only
  when a `session_before_compact` handler returned replacement compaction content
  (`agent-session.js:1430-1438`). pi-link's handler returns nothing, so the field
  is `false` even for a compaction pi-link triggered remotely. **Never use it to
  identify a pi-link remote request** — `compactRunning` remains pi-link's
  remote-ownership state, but it is not an attempt id and cannot by itself
  correlate this failure event.
- **`willRetry` is currently always `false`.** All five emit sites hardcode it
  (`agent-session.js:1513`, `:1605`, `:1701`, `:1744`, `:1807`), so no manual path
  in 0.84.3 can deliver `true`. Do not build on that: treat a `true` value as
  possible in a future release and decide explicitly what it should mean rather
  than ignoring the field.
- **Keep the two flags separate.** Once ownership is established, a failure handler
  may change only `localCompacting`. Remote ownership is cleared by `finish()`
  (`index.ts:798`), which also
  drains and sends the callback. A handler that touched `compactRunning` would
  risk a duplicate callback or a double drain.
- **Do not remove any existing fallback.** Success, `agent_start` and the deadline
  must all stay. The event is an *early* release, not a replacement. The deadline
  remains the unconditional bound on 0.84.2, where this event is never emitted.

## Compatibility

- **A handler alone does not force a floor bump.** Pi's extension runtime stores
  handlers in a plain `Map` keyed by the event string with no validation of the
  key (`dist/core/extensions/loader.js`, the `on(event, handler)` implementation),
  so such a runtime keeps the handler and simply never emits the event. *This was
  read on installed Pi 0.84.3. Pi 0.84.2 was inspected earlier in this environment
  and had the same unvalidated handler-map behaviour, but it was replaced by the
  0.84.3 install and was not re-read afterwards. Claim it for those two versions
  only — do not generalise it to arbitrary older runtimes.*
- **The type surface is the real question.** 0.84.2's public `on()` overloads do
  not include `session_compact_failed`, so registering it there is a typing
  problem even though it is runtime-safe. Since pi-link ships `index.ts` as source
  with no typecheck step, this is a policy decision to take explicitly, not a
  detail to discover later.
- **Raising `MIN_PI_VERSION` is a choice, not a consequence** — unless the
  implementation removes a fallback or otherwise depends on the new behaviour. Do
  not prescribe a version number here.

## Bounded candidate direction

Not an implementation. If taken up:

- **First**, establish a reliable correspondence between the failure event and the
  `session_before_compact` that raised the *current* gate — by serializing manual
  attempts, by tracking attempt identity in pi-link, or by an upstream guarantee.
  **Only then** may a handler call `setCompacting(false)`, reusing that function so
  the deadline is cleared and `releaseInbox()` runs through the existing path.
  **If the payload of the day still cannot prove ownership, preserve the existing
  fallbacks and do not implement early release at all** — a 180-second wait is
  strictly better than releasing another compaction's gate;
- decide and document what `willRetry === true` should do before it can occur;
- correct the now-stale comment at `index.ts:541-546`, which states that a failed
  manual compaction reaches session listeners "never to extensions" and that
  success is "the sole positive ending an extension can observe" — false on
  0.84.3. Correct it **when implementing**, not before;
- update `README.md:307` and the public skill's cancellation wording **only when
  the behaviour actually changes**.

## Validation gates for that future work

1. Focused lifecycle-harness tests driving the **real registered handlers**, not a
   stub of them.
2. Manual failure and manual abort each clear the gate and release queued delivery
   promptly.
3. Success still clears normally through `session_compact`.
4. Threshold and overflow failures neither create nor clear the manual gate.
5. A remote-request failure composes correctly with `compactRunning` ownership and
   `onError`: exactly one callback, exactly one drain.
6. **A failure that occurs before `session_before_compact`** — no model, auth
   failure, `Already compacted`, `Nothing to compact` — does **not** clear a manual
   gate raised by a different, still-running compaction.
7. **A stale or overlapping manual failure does not clear a newer gate**: a late
   failure from attempt A must leave attempt B's gate standing.
8. If the floor stays at 0.84.2, confirm the fallback behaviour there is still
   bounded by the deadline.
9. The complete existing suite passes.
10. A live two-terminal confirmation, **after** the harness and source proof — not
    instead of them.

## Evidence calibration

- **Source-verified:** the event payload, all five emit sites and their hardcoded
  `willRetry: false`, the manual failure ordering, the meaning of `fromExtension`,
  and pi-link's current gate/flag/fallback structure. All read directly in this
  environment at the versions pinned above.
- **Not live-observed:** no compaction was failed or cancelled to watch this
  event fire, and no handler was written or run. The ordering claim comes from
  reading `agent-session.js`, not from a trace.
- **This is an opportunity, not an incident.** No user reported held messages. It
  was inferred while reviewing the Pi 0.84.3 changelog against pi-link's source.

## Relationship to `REPORT-compact-race.md`

A separate upstream defect — and **not evidence that the historical race is
fixed**. That report documents an upstream reentrancy defect in `compact()` plus
pi-link's mitigation, and its open item is a *pre*-announcement window: a remote
request landing after a local `/compact` has aborted and authorised but before Pi
announces it.

That unresolved overlap window is **directly why the ownership validation above is
required**: it is exactly the situation in which two manual attempts coexist, so a
failure event from one can arrive while the other holds the gate. The new event
neither fixes that race nor gives any way to tell the attempts apart.

## Non-goals

No handler now. No change to 0.3.0 behaviour or its shipped documentation. No OMP
work. No protocol, version, install, tag, push or publish action.
