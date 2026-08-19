# PLAN — Delivery quality consolidation

> **Status:** Design closed — source of truth for the unified delivery model
> **Last aligned:** 2026-07-17
> **Build from this?** No — build from `PLAN-unified-delivery.md`, which turns
> these decisions into ordered tasks. This file records *why* the design is what
> it is; that plan records *what to change*. All design questions, including
> compaction, are now decided.
> **Summary:** Replace pi-link's two sender-selected delivery modes with one
> attributed, batched message path. Pi atomically steers a running receiver or
> starts an idle one. Remove the unsafe plain-append path and the human
> `/link-broadcast` command, then resolve routing truth, compact safety, timeout
> clarity, documentation, migration, and live verification as one quality pass.

## Purpose

This document consolidates the delivery investigation that followed the
async-only messaging release. It supersedes the original D1–D6 brainstorming in
this file and the delivery assumptions in `PLAN-doc-accuracy.md`.

It is a **design source of truth**, not yet an implementation brief. The next
conversation is compact safety. Once that is decided, rewrite this into bounded,
ordered implementation tasks and send it through independent plan review before
building.

Apply the standing value filter throughout:

> **Simple, performant, readable, idiomatic code, with every line justified and
> abstractions used only when essential.**

Prefer deletion. Do not build acknowledgements, receipts, durable queues, or a
new state machine unless a demonstrated requirement cannot be met by Pi itself.

## Baseline and source truth

Verified against pi-link at `f1b1042` and the currently installed:

- `@earendil-works/pi-coding-agent` **0.84.2**;
- nested `@earendil-works/pi-agent-core` **0.84.2**.

Earlier reports labelled these findings as Pi 0.80.3. That label was wrong; the
cited files were from 0.84.2. Current behavior, not the stale label, governs this
plan.

### Pi's atomic delivery behavior

`AgentSession.sendCustomMessage()` evaluates the receiver's state itself:

1. while running, `{ triggerTurn:true }` calls `agent.steer()`;
2. while idle, the same call starts a new agent prompt.

No pi-link-side `isIdle()` branch is needed to choose between those outcomes.
Pi's check is atomic against its current state.

Steering is a boundary delivery, not an abort: the current assistant response and
its tool calls finish, then the message is injected before the next LLM call.

### Late steering is rescued in Pi 0.84.2

The earlier claim that a steer arriving after the loop's final steering drain can
remain invisible until an unrelated future run was wrong.

After the core loop emits `agent_end`, `AgentSession._handlePostAgentRun()` checks
`agent.hasQueuedMessages()`. Messages queued by late or `agent_end`-time steering
cause `agent.continue()`, which drains them into a continuation run. The source
comments explicitly name this case.

There is no residual scheduler-visible window for current pi-link traffic:

- the final queue check is synchronous;
- the transition to `_isAgentRunActive = false` occurs before
  `_emitAgentSettled()` first yields;
- pi-link ingress and its 200 ms flush are WebSocket/timer macrotasks, which
  cannot interleave inside that microtask/synchronous transition.

**Invariant to preserve:** delivery must remain rooted in the current
WebSocket/timer path. Do not move the final `sendCustomMessage()` call into an
unexamined promise continuation without revalidating this ordering.

### Plain append is not steering and is unsafe

The current explicit-`false` path skips Pi's steering branch and appends directly
to `agent.state.messages` and session history.

Two source findings make that path unacceptable:

1. **Snapshot isolation:** an active run works on a context snapshot copied at
   run start. A later plain append is not included in that run's next LLM call.
   It is persisted and displayed, but it is not live steering.
2. **Tool ordering:** during tool execution, the append can produce
   `assistant(tool_call) -> custom/user message -> tool_result`. Pi does not
   reorder this before provider conversion. This can violate provider protocols,
   including Anthropic's requirement that a tool result immediately follow its
   tool use.

Removing explicit false therefore eliminates both an ambiguous API mode and a
potential provider-ordering defect.

### Crash durability is out of scope

A steer lives in memory until Pi injects and persists it. Abrupt process death in
that interval may lose it. The owner explicitly rejected crash-survival as a
meaningful requirement. Do not add a sidecar, write-ahead log, delivery receipt,
or replay protocol for it.

## Owner decisions — closed

These are no longer options:

1. **One public send shape:** `link_send({ to, message })`. Remove
   `triggerTurn` from the tool schema, wire message, rendering, examples, skills,
   and templates.
2. **Always act:** internally, every received agent message is delivered to Pi
   with `{ triggerTurn:true }`.
3. **Receiver state chooses behavior:** running means native Pi steering at the
   next safe boundary; idle means a new turn.
4. **Keep batching:** retain the 200 ms debounce, item/character caps, arrival
   order, and one combined delivery for nearby messages. Remove only the wait for
   receiver idleness.
5. **Attribute every delivery:** retain the `[Link: N message(s) received]` and
   `From "name":` wrapper for both triggered and steered batches.
6. **Remove the human `/link-broadcast` command.** Do not replace it with a UI
   notification or another human announcement surface.
7. **Remove broadcast messaging entirely.** `link_send` no longer accepts `"*"`.
   Every message has exactly one named recipient. Fan-out to a mesh where every
   message demands attention is not worth its cost, and a sender who genuinely
   needs to reach several peers can address them deliberately. Presence and status
   messages keep using the hub's internal broadcast; only chat loses it.
8. **Intent belongs in the message and policy belongs in the skill.** The
   transport does not carry a second intent bit.
9. **No custom steering mechanism.** Do not build append tracking, session
   inspection, fallback turns, context-event injection, pending IDs, or duplicate
   suppression. Native Pi steering already supplies the required normal-operation
   guarantee more safely.
10. **Compaction defers delivery.** A terminal that is compacting receives
    nothing. Messages stay in the existing inbox and are delivered when it ends.
11. **One compaction at a time.** pi-link never starts a compaction while it
    believes one is running; a second request is declined as `busy`. It does not
    wait, queue, or replace the first.
12. **Extension-only.** No change to Pi is required or permitted for this work.
    Where Pi's own behavior is defective, report it upstream instead of patching
    around it.

## Coordination policy — the sender's responsibility

The simplified transport makes attention explicit:

> Sending to a busy agent means steering its current work. Do it only when the
> message should enter that run. If it must not influence the run, wait until the
> agent is idle.

The coordination skill must teach:

- corrections, blockers, stop instructions, relevant constraints, and actionable
  callbacks are valid steering;
- unrelated tasks, courtesy acknowledgements, and no-effect FYIs should wait;
- state intent plainly in the body: what changed, whether action is required, and
  whether current work should continue;
- execution authority still travels inside every executable dispatch;
- a message requiring no reply gets no reply; never create acknowledgement loops;
- there is no fan-out: address each peer deliberately, and let that cost discipline
  what you send.

Examples should use ordinary language, not introduce a mandatory keyword
vocabulary.

## Quality workstreams

### Q1 — Unify delivery

**Goal:** one receiver ingress and one Pi delivery call.

Required changes:

- remove `ChatMsg.triggerTurn` and all sender/default plumbing;
- remove `triggerTurn` from the `link_send` TypeBox schema and tool result text;
- remove `(no turn)` / `(trigger all)` mode badges that describe the deleted bit;
- make every incoming chat enter the same attributed inbox;
- keep debounce, caps, ordering, disconnect cleanup, and wrapper construction;
- remove `IDLE_RETRY_MS`, the `ctx.isIdle()` deferral/retry, and the `agent_end`
  kick whose only purpose is waiting for idleness;
- flush each batch immediately with internal `{ triggerTurn:true }`;
- never call the plain-append arm for linked agent traffic.

Expected shape: a net deletion. Sol estimated roughly 45–60 lines removed from
`index.ts` when batching is retained.

**Acceptance behavior:**

| Receiver state | Required result |
| --- | --- |
| idle | one new model turn for the batch |
| assistant streaming | batch steers after the current assistant response |
| tools running | tools finish; batch steers before the next LLM call |
| core loop ending | Pi's post-run queue check creates a continuation |
| several messages within 200 ms | one attributed batch and one LLM iteration |
| several messages outside the window | one iteration per flushed batch |

### Q2 — Remove broadcast messaging (decided)

Delete the human command end to end: registration, handler, help text, README and
skill references, and any example that advertises it. Do not replace it.

Also remove agent fan-out: `link_send` no longer accepts `"*"`. This is a
subtraction, not a substitution — with one universal delivery mode, a broadcast
would force a turn on every connected peer, which is precisely the cost the design
asks senders to weigh.

Consequences worth noting while implementing:

- the self-target and `targetNotFound` guards stop being conditional and apply to
  every send;
- `ChatMsg.to` is always a single terminal name;
- the hub's internal broadcast stays — presence (`joined` / `left`), rename, and
  status updates still use it. Only chat loses fan-out.

This also closes D4 outright: a send that reports success to nobody is no longer
expressible, so no recipient count is needed.

### Q3 — Routing failure visibility (deferred, documented)

The old D2 gap stands: a client's send can report “sent to hub” from a stale local
roster, the hub then fails to route, and the failure surfaces only as a human
notification. The sending model never learns.

**Decision: document now, build later.** The coordination guidance must state that
a client's success means the hub accepted the message, not that it arrived, and
that a missing callback — not a send error — is the failure signal.

Deferred for a separate decision, not abandoned. If it is revisited, the candidate
direction is to deliver the hub's existing routing error back to the sender as an
ordinary attributed message through the unified path, which would need proof that
it cannot route to itself or start an error loop. Do not build receipts,
correlation, or any blocking RPC.

### Q4 — Compact safety (decided, extension-only)

Pi already applies this exact policy to human input: `interactive-mode.js:2478-2489`
checks `session.isCompacting` and queues typed text instead of submitting it. We
extend the same rule to linked messages. Coverage differs by compaction path.

**Automatic (threshold and overflow) — already correct, no code.** Auto-compaction
runs inside `_runAgentPrompt`, so `_isAgentRunActive` stays true. Inbound messages
reach the steering arm, and `_runAutoCompaction` ends with
`return this.agent.hasQueuedMessages()` under the comment *“Auto-compaction can
complete while follow-up/steering/custom messages are waiting. Continue once so
queued messages are delivered.”* Delivery after compaction is Pi's behavior, not
ours.

**Remote `link_compact` — already tracked.** `compactRunning` (`index.ts:147`) is
set before `ctx.compact()` and cleared exactly once by `finish()`. Only the inbox
needs to consult it.

**Manual `/compact` — the only new work.** It is intercepted by the TUI at
`interactive-mode.js:2425` and never reaches `AgentSession.prompt()`, so it cannot
be shadowed by an extension command and raises no `input` event.
`session_before_compact` is the earliest extension-visible signal and fires for all
three reasons (`manual`, `threshold`, `overflow`).

**State machine.** One boolean, one source, four independent releases:

| Transition | Source |
| --- | --- |
| set true | `session_before_compact` |
| clear on success | `session_compact` |
| clear on abort | `abort` listener on `event.signal` |
| clear on resumed activity | `agent_start` |
| clear on safety deadline | timer |

The deadline is mandatory, not defensive padding: on a failed compaction Pi emits
`compaction_end` only to session listeners, never to extensions, so success and
abort are the only positive endings an extension can observe. Without a deadline a
failure would strand the flag and hold messages forever.

**Applies to.** `flushInbox` defers while compacting; the `compact_request` guard
declines while compacting.

**Accepted residual gap — documented, not engineered around.** `compact()` runs
`await this.abort()` plus auth and preparation *before* emitting
`session_before_compact`. A flush inside that window starts a turn against context
about to be rebuilt. The message itself is safe: it is persisted as a session entry
and `buildSessionContext()` restores it, so nothing is lost — the cost is a wasted
turn. Do not add heuristics to guess at this window.

**Upstream, not ours.** `AgentSession.compact()` assigns
`_compactionAbortController` *after* `await this.abort()`
(`agent-session.js:1368-1369`) and has no reentrancy guard, so two overlapping
compactions can clobber the shared field — the `reading 'signal'` crash in
`REPORT-compact-race.md`. Our guard removes pi-link as one of the two participants;
it cannot fix Pi. File it upstream with evidence and line numbers. Do not patch Pi.

### Q5 — Compact timeout (decided)

`COMPACT_TIMEOUT_MS` (`index.ts:27`) bounds the caller's wait only; nothing aborts
the target, which usually finishes. Correct the wording, not the mechanism:

> Timed out after 180s; the target may still be compacting. Re-check with
> `link_list` before retrying.

No cancellation machinery. A retry that arrives while the target is still working
now declines as `busy` through the Q4 guard, which is the honest answer.

### Q6 — Rewrite documentation from the new semantics

`PLAN-doc-accuracy.md` predates the unified-delivery decision and must not execute
as written. Its false-delivery corrections and “callbacks only arrive as clean new
turns” rule become wrong under this plan.

Update together:

- `README.md`;
- `skills/pi-link-coordination/SKILL.md` in the project;
- the live/synced coordination skill as applicable through the normal project
  sync;
- `pi-link-implement-review-commit/SKILL.md`;
- `templates/dispatch-brief.md`;
- `templates/review-brief.md`;
- `templates/commit-brief.md`;
- roadmap/status references after the behavior ships.

Documentation must state one mental model:

> A linked message always demands model attention. It steers a running receiver
> at Pi's next safe boundary or starts an idle receiver. The sender controls intent
> through clear content and responsible timing, not a transport flag.

Also retain the still-valid rules:

- approval/authority travels with executable work;
- `BLOCKED` and material deviation callbacks are immediate and explicit;
- messages are batched for 200 ms and attributed by sender;
- send success and final hub routing are distinct until Q3 says otherwise;
- no-action messages receive no acknowledgement;
- mixed-version meshes are unsupported during this schema migration.

Pay for additions by deleting all false/true mode tables, non-waking FYI advice,
human broadcast guidance, and duplicate explicit-true examples.

### Q7 — Atomic migration and release handoff

Removing the schema property is a coordinated breaking change:

- TypeBox may reject old calls that still pass `triggerTurn`;
- a new sender omitting the field against an old receiver can be interpreted as
  false/undefined and recreate silent plain append;
- the orchestration skill and all three templates currently pass the field
  explicitly.

Therefore code, README, both skills, and templates must change atomically in one
behavioral commit or one inseparable commit series with no advertised mixed state.
All linked terminals must upgrade and restart together.

Do not change version, CHANGELOG, package metadata, lockfiles, publish state, or
release metadata unless the owner explicitly requests it. Preserve the owed
release note:

> Upgrade and restart all linked terminals together; mixed-version messaging is
> unsupported.

## Closed gaps and remaining gaps

| Former gap | Disposition under this plan |
| --- | --- |
| D1: false to idle may never be read | **Closed structurally:** false removed; every message triggers or steers |
| Mid-tool plain append ordering | **Closed structurally:** pi-link never uses plain append for linked traffic |
| D2: optimistic client send can reach nobody | **Deferred, documented:** Q3 |
| D3: message/compaction race | **Decided:** Q4 — one flag, four releases, extension-only; narrow pre-emit window documented |
| D4: broadcast success with zero recipients | **Closed structurally:** Q2 — broadcast removed entirely |
| D5: raw delivery has no sender identity | **Closed structurally:** every batch uses the sender wrapper |
| D6: compact timeout is ambiguous | **Decided:** Q5 — wording only |
| Late steer after final drain | **Closed by Pi 0.84.2:** post-run continuation; no pi-link-visible residual window |
| Crash before steer persistence | **Explicitly out of scope** |

## Verification strategy

Do not rely on a single subject's self-report. Every live behavioral test requires
an observable read-back or source-visible state.

### Static gates

Exact commands and line references must be refreshed after Q4 and final task
planning. At minimum require:

```sh
npx --yes esbuild index.ts --bundle --platform=node --format=esm \
  --external:@earendil-works/* --external:ws --external:typebox \
  --external:node:* --outfile=/tmp/pi-link-check.mjs
node --check bin/pi-link.mjs
node test/cli-flags-test.mjs

git diff --check

# Public modes and the removed human command must disappear from guidance.
! rg -n 'triggerTurn|trigger turn|no turn|non-waking|/link-broadcast' \
  README.md skills/pi-link-coordination/SKILL.md \
  ../../skills/pi-link-implement-review-commit

# Removed schema/wire/plain-append paths must not survive under another name.
! rg -n 'params\.triggerTurn|msg\.triggerTurn|triggerTurn:\s*false|deliverAs:.*steer|/link-broadcast' index.ts

# The one internal Pi activation remains; inspect every match.
rg -n 'triggerTurn:\s*true' index.ts
```

The final gates must be refreshed against the resulting files and scoped around
the one justified internal `{triggerTurn:true}` call. Historical CHANGELOG and
archived plan text are deliberately outside the absence checks.

### Required live gates

Use disposable terminals and read back the resulting behavior:

1. idle direct send starts exactly one turn;
2. send during a long tool call does not abort it and is read at the next boundary;
3. send at run completion is consumed by Pi's continuation, not stranded;
4. several sends inside 200 ms become one attributed batch;
5. sends outside the window create ordered separate batches;
6. sender attribution is present on every delivery;
7. `link_send` rejects `"*"` like any other unknown terminal name;
8. `/link-broadcast` is absent;
9. old explicit-`triggerTurn` calls fail in the expected migration environment,
   while all updated skills/templates dispatch successfully;
10. compact cases defined by Q4 pass across manual, remote, automatic, timeout,
    and error paths.

## Sequencing

Design is closed. Execution is sequenced in `PLAN-unified-delivery.md`:
three independent plan reviews, owner approval, then implement → review → commit,
then a whole-mesh restart and the live gates.

## Explicit non-goals

- crash/restart durability for in-memory steering;
- delivery receipts or synchronous acknowledgements;
- reintroducing `link_prompt` or any blocking agent RPC;
- custom steering, context-event injection, append-and-prove heuristics, or
  duplicate suppression;
- mandatory message keywords;
- a replacement human broadcast command;
- versioning, publishing, or release metadata without separate owner approval.
