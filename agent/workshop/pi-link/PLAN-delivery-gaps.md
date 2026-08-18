# PLAN — Delivery quality consolidation

> **Status:** Design consolidated — NOT executable yet
> **Last aligned:** 2026-07-17
> **Build from this?** No. The unified delivery direction is owner-approved as a
> design, but the compact-safety section is deliberately unresolved and the
> resulting executable task plan has not been reviewed or approved.
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
7. **Keep agent broadcast through `link_send({to:"*", ...})` unless a later
   decision explicitly removes it.** It is an active fan-out: it steers busy
   receivers and starts idle ones.
8. **Intent belongs in the message and policy belongs in the skill.** The
   transport does not carry a second intent bit.
9. **No custom steering mechanism.** Do not build append tracking, session
   inspection, fallback turns, context-event injection, pending IDs, or duplicate
   suppression. Native Pi steering already supplies the required normal-operation
   guarantee more safely.

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
- broadcasting is active fan-out and must be used with the same discipline,
  multiplied by every receiver.

Examples should use ordinary language, not introduce a mandatory keyword
vocabulary.

## Quality workstreams

### Q1 — Unify direct and broadcast delivery

**Goal:** one receiver ingress and one Pi delivery call.

Required changes:

- remove `ChatMsg.triggerTurn` and all sender/default plumbing;
- remove `triggerTurn` from the `link_send` TypeBox schema and tool result text;
- remove `(no turn)` / `(trigger all)` mode badges that describe the deleted bit;
- make every incoming direct or agent-broadcast chat enter the same attributed
  inbox;
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

### Q2 — Remove `/link-broadcast`; make agent broadcast truthful

Delete the human command end to end:

- command registration/handler and help/README/skill references;
- any hardcoded non-waking send;
- tests or examples that advertise it.

Agent `to:"*"` remains. Its result must not claim success to an unspecified
fleet. Resolve the old D4 gap by returning the number of recipients accepted by
the hub, including zero, if that count can be propagated without request/response
machinery. If client architecture cannot know the hub's count synchronously,
document the exact optimistic boundary rather than invent a receipt protocol.

**Decision still needed:** whether recipient count is available cheaply for both
hub-local and client-originated broadcasts. Investigate before assigning a code
task.

### Q3 — Surface routing failure to the sending model

The old D2 gap remains: a client can report “sent to hub” after a stale local
roster entry, then the hub finds no target. Today the returned hub error becomes a
human-only toast; the sending model never learns.

Required design qualities:

- preserve asynchronous-only messaging;
- do not reintroduce send/response correlation, waiting, delivery receipts, or
  prompt RPC;
- make a hub routing failure model-visible and attributed to the failed target;
- avoid acknowledgement or error loops;
- explain that initial client success means hub acceptance, not final delivery.

Candidate minimal direction: convert the existing returned hub error into an
attributed asynchronous custom message to the sender, using the same active
message semantics. Validate that this cannot recursively route or trigger itself.

**Decision still needed:** build the async failure notice or document missing
callback + `link_list` as the failure signal. Prefer code only if the notice is a
small reuse of existing paths.

### Q4 — Resolve compact safety

This is the next design discussion and remains the only blocker to turning this
consolidation into an executable plan.

The prior P0 report (`REPORT-compact-race.md`) was written against Pi 0.79.1 and
must be re-audited against Pi 0.84.2 before adopting its mitigation. The old plan
assumed compaction was invisible to extensions and that `ctx.isIdle()` alone
controlled delivery; both the Pi lifecycle and the proposed delivery path have
changed.

Investigate all four paths independently:

1. manual/user compaction;
2. remote `link_compact`;
3. automatic compaction after an agent run;
4. failed, aborted, or timed-out compaction.

For each, establish from current source and a minimal live probe:

- when `_isAgentRunActive` / `ctx.isIdle()` changes;
- whether inbound `{triggerTurn:true}` steers, starts, waits, rejects, or races;
- which extension events fire at start, completion, abort, and error;
- whether `session_before_compact`, `session_compact`, and `agent_settled` form a
  complete usable state machine;
- whether current Pi already prevents overlapping compact calls;
- whether a message queued during auto-compaction is rescued by
  `_handlePostAgentRun()`;
- what local state, if any, pi-link must retain;
- how remote compact timeout interacts with subsequent sends and retries.

Do not add a `compactRunning` abstraction for paths Pi already serializes. The
best outcome is deletion or no change; a guard is justified only for a reproduced
current-version race.

### Q5 — Clarify compact timeout

The old D6 gap remains unless current Pi changed it: pi-link's three-minute timeout
ends the caller's wait but does not necessarily abort target compaction.

After Q4 source validation, choose the smallest honest result:

- if target work continues, say “timed out; target may still be compacting”;
- if Pi 0.84.2 now aborts or exposes settled state, describe that actual behavior;
- tell the caller when retrying is safe.

A wording correction is preferred over new cancellation machinery.

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
| D2: optimistic client send can reach nobody | **Open:** Q3 |
| D3: message/compaction race | **Open and blocking:** Q4, revalidate on Pi 0.84.2 |
| D4: broadcast success with zero recipients | **Open for agent broadcast:** Q2; human command removed |
| D5: raw delivery has no sender identity | **Closed structurally:** every batch uses the sender wrapper |
| D6: compact timeout is ambiguous | **Open:** Q5 |
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
6. sender attribution is present on every direct and agent-broadcast delivery;
7. agent broadcast activates every connected peer and reports/communicates the
   actual recipient boundary decided in Q2;
8. `/link-broadcast` is absent;
9. old explicit-`triggerTurn` calls fail in the expected migration environment,
   while all updated skills/templates dispatch successfully;
10. compact cases defined by Q4 pass across manual, remote, automatic, timeout,
    and error paths.

## Sequencing after compact design is resolved

1. Finish Q4/Q5 decisions and update this document.
2. Reconcile or retire `PLAN-doc-accuracy.md` and update `PLAN-roadmap.md` so no
   stale source advertises the old modes.
3. Convert Q1–Q7 into small executable tasks with exact paths, ownership, gates,
   and commit boundaries.
4. Independent source-truth plan review (Opus lens).
5. Independent simplicity/value plan review (Fable lens).
6. Independent practitioner/migration plan review (Sol lens).
7. Owner approves the reviewed executable plan.
8. Execute implementation → review → commit under the orchestration pipeline.
9. Restart the entire mesh together and run the live gates.

## Explicit non-goals

- crash/restart durability for in-memory steering;
- delivery receipts or synchronous acknowledgements;
- reintroducing `link_prompt` or any blocking agent RPC;
- custom steering, context-event injection, append-and-prove heuristics, or
  duplicate suppression;
- mandatory message keywords;
- a replacement human broadcast command;
- versioning, publishing, or release metadata without separate owner approval.
