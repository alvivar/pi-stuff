# PLAN — Unified link delivery

> **Status:** Executable — awaiting three plan reviews, then owner approval
> **Last aligned:** 2026-07-17
> **Build from this?** Not yet. Reviews first, then explicit owner go.
> **Supersedes:** `PLAN-delivery-gaps.md` (design, now folded in) and
> `PLAN-doc-accuracy.md` (its surviving rules are folded into Task 5). Both are
> deleted by this plan.
> **Summary:** One message shape, one delivery path, one recipient.
> `link_send({to, message})` always acts: Pi steers a running receiver at its next
> safe boundary, or starts a turn on an idle one. Removes `triggerTurn`, the
> plain-append path, `/link-broadcast`, and chat fan-out. Adds a compaction gate.
> Net subtraction.

Apply the standing value filter throughout:

> **Simple, performant, readable, idiomatic code, with every line justified and
> abstractions used only when essential.**

Prefer deletion. Do not build acknowledgements, receipts, durable queues, or a new
state machine unless a demonstrated requirement cannot be met by Pi itself.

## Ground rules

- **Extension-only.** Do not modify Pi. Where Pi is defective, report upstream.
- **No new abstractions.** One boolean for compaction; no state machine, no
  receipts, no durable queue, no acknowledgement protocol.
- **Atomic.** Code, README, both skills, and all templates land together. No
  intermediate state may advertise a tool shape that no longer exists.
- **No metadata.** No version, CHANGELOG, package, lockfile, publish, or release
  changes without a separate owner instruction.
- **Verify line numbers before editing.** All references are from `index.ts` at
  `f1b1042` and Pi 0.84.2; re-check each site rather than trusting the number.

---

## Source truth — why the design is what it is

Verified against pi-link at `f1b1042` and the installed
`@earendil-works/pi-coding-agent` **0.84.2** with nested `pi-agent-core` **0.84.2**.
Earlier reports labelled these findings 0.80.3; that label was wrong, the cited
files were 0.84.2. **Do not re-derive any of this** — it is the expensive part.

### Pi already decides atomically

`AgentSession.sendCustomMessage()` (`agent-session.js:1078-1097`) evaluates the
receiver's state itself, first match winning:

1. `deliverAs:"nextTurn"` → parked, drained only by a human `prompt()`;
2. `isStreaming && triggerTurn !== false` → `agent.steer()`;
3. `triggerTurn` truthy → new turn;
4. otherwise → plain append.

So `{ triggerTurn:true }` alone already means *steer if running, else start a
turn*, checked atomically against Pi's own state. pi-link never reached the steer
arm only because its inbox waits for idleness first. **This change is a deletion,
not new logic.**

Steering is a boundary delivery, not an abort: the current assistant response and
its tool calls finish, then the message is injected before the next LLM call.

### Late steering is rescued

An earlier claim that a steer arriving after the loop's final drain could stay
invisible was **formally retracted**. `_runAgentPrompt` (`agent-session.js:744-757`)
loops `while (await this._handlePostAgentRun()) await this.agent.continue()`;
`_handlePostAgentRun` returns `agent.hasQueuedMessages()` (`:779-781`) under a
comment naming exactly this case, and `agent.continue()` (`agent.js:234-255`)
drains steering.

No residual scheduler-visible window exists for pi-link traffic: the final queue
check is synchronous, `_isAgentRunActive` is cleared at `:328` before
`_emitAgentSettled` first yields, and pi-link ingress is WebSocket/timer
macrotasks that cannot interleave inside that microtask/synchronous stretch.

> **Invariant to preserve:** delivery must stay rooted in the current
> WebSocket/timer path. Never move the final `sendCustomMessage()` into an
> unexamined promise continuation without revalidating this ordering.

### Plain append is not steering, and it is unsafe

Today's explicit-`false` path skips the steering branch and appends directly to
message state. Two source findings condemn it:

1. **Snapshot isolation.** `createContextSnapshot` (`agent.js:280-286`) copies
   `_state.messages` at run start and the loop works on that copy, so a later
   append is *not* in that run's next LLM call. It is persisted and displayed, but
   it is not live steering.
2. **Tool ordering.** During tool execution the append lands between `tool_call`
   and `tool_result`, and Pi does not reorder before provider conversion. This can
   violate Anthropic's requirement that a tool result immediately follow its tool
   use.

Removing explicit `false` deletes both an ambiguous API mode and a latent
provider-ordering defect.

### Batching must survive

Pi drains steering **one message per loop iteration**, so N queued messages cost N
LLM calls. The 200 ms debounce is what keeps a burst to one iteration.

### Compaction facts

- Pi already applies the target policy to human input:
  `interactive-mode.js:2478-2489` checks `session.isCompacting` and queues typed
  text instead of submitting it. We extend the same rule to linked messages.
- **Automatic (threshold/overflow) is already correct.** It runs inside
  `_runAgentPrompt`, so messages queue as steering, and `_runAutoCompaction` ends
  with `return this.agent.hasQueuedMessages()` under the comment *"Auto-compaction
  can complete while follow-up/steering/custom messages are waiting. Continue once
  so queued messages are delivered."*
- **Remote `link_compact` is already tracked** by `compactRunning`
  (`index.ts:147`), set before `ctx.compact()` and cleared exactly once by
  `finish()`.
- **Manual `/compact` is the only gap.** The TUI intercepts it at
  `interactive-mode.js:2425`; it never reaches `AgentSession.prompt()`, so it
  cannot be shadowed by an extension command and raises no `input` event.
  `session_before_compact` is the earliest extension-visible signal and fires for
  all three reasons (`manual`, `threshold`, `overflow`).
- `isCompacting` (`agent-session.js:647-651`) exists but is **not** exposed on
  `ExtensionContext`, so the flag in Task 3 is the only available substitute.

### Crash durability is out of scope

A steer lives in memory until Pi injects and persists it. Abrupt process death in
that interval may lose it. The owner rejected crash survival as a meaningful
requirement. No sidecar, write-ahead log, receipt, or replay protocol.

---

## Owner decisions — closed

These are no longer open for review; a reviewer may flag a consequence, not
reopen the choice.

1. **One public send shape:** `link_send({ to, message })`. Remove `triggerTurn`
   from schema, wire, rendering, examples, skills, and templates.
2. **Always act:** internally every received agent message is delivered with
   `{ triggerTurn:true }`.
3. **Receiver state chooses behavior:** running → native steering at the next safe
   boundary; idle → new turn.
4. **Keep batching:** 200 ms debounce, item/character caps, arrival order, one
   combined delivery. Remove only the wait for idleness.
5. **Attribute every delivery:** keep `[Link: N message(s) received]` and
   `From "name":` on every batch.
6. **Remove `/link-broadcast`** with no replacement — no `ctx.ui.notify()` or other
   human announcement surface.
7. **Remove broadcast messaging entirely.** `link_send` no longer accepts `"*"`.
   Fan-out to a mesh where every message demands attention is not worth its cost;
   a sender who must reach several peers addresses them deliberately. Presence,
   rename, and status keep the hub's internal broadcast — only chat loses it.
8. **Intent belongs in the message, policy in the skill.** The transport carries no
   second intent bit.
9. **No custom steering mechanism.** No append tracking, session inspection,
   fallback turns, context-event injection, pending IDs, or duplicate suppression.
10. **Compaction defers delivery.** A compacting terminal receives nothing;
    messages wait in the existing inbox and arrive afterwards.
11. **One compaction at a time.** A second request is declined `busy` — never
    queued, replaced, or overlapped.
12. **Extension-only.** Pi is not modified; its defects are reported upstream.

---

## Baseline to establish before Task 1

Record each result; do not start if any fails.

```sh
cd agent/workshop/pi-link
git status --short                       # clean or plan files only
npx --yes esbuild index.ts --bundle --platform=node --format=esm \
  --external:@earendil-works/* --external:ws --external:typebox \
  --external:node:* --outfile=/tmp/pi-link-check.mjs
node --check bin/pi-link.mjs
node test/cli-flags-test.mjs             # expect 49/49
```

---

## Task 1 — Remove `triggerTurn` and unify ingress

**File:** `index.ts`

**Delete:**

- `ChatMsg.triggerTurn` (`:67`) and every read/write of it on the wire.
- The `triggerTurn` schema property and its description (`:1176-1182`).
- `const triggerTurn = params.triggerTurn ?? true` and the outgoing field
  (`:1199-1205`).
- `triggerTurn` from the tool result details (`:1219`).
- Both mode badges in `renderCall` (`:1231-1235`): `(no turn)` and `(trigger all)`.
- The `else` branch of the `chat` case that plain-appends with
  `{ triggerTurn:false, deliverAs:"steer" }` (`:596-609`). **No linked traffic may
  ever reach Pi's plain-append arm again.**
- `IDLE_RETRY_MS` (`:30`) and the `ctx.isIdle()` deferral in `flushInbox`
  (`:354-365`), including both `scheduleFlush(IDLE_RETRY_MS)` retries
  (`:363`, `:392`).
- The `agent_end` inbox kick (`:1116-1118`) — it exists only to wait for idleness.
  Removing it is required, not optional: leaving it would re-flush at a boundary
  the design no longer cares about.

**Keep unchanged:** `FLUSH_DELAY_MS` 200, `BATCH_MAX_ITEMS` 20,
`BATCH_MAX_CHARS` 16_000, arrival ordering, the `[Link: N message(s) received]` +
`From "name":` wrapper, disconnect cleanup, and the `link_send` self-target and
`targetNotFound` guards.

**Reschedule delay:** when the batch caps leave items behind, reschedule with
`FLUSH_DELAY_MS`, not a new constant. `IDLE_RETRY_MS` existed only to poll for
idleness; with the gate gone there is nothing to poll for.

**Result:** every inbound `chat` enters the inbox, is batched, wrapped, and
delivered with one call:

```ts
pi.sendMessage({ customType: "link", content: wrapped, display: true, details }, { triggerTurn: true });
```

Do not inspect receiver state in pi-link: that check has a lost interleaving and
Pi's does not.

**Update the tool description** to state the single behavior: the message always
acts, steering a busy receiver at its next safe boundary or starting a turn on an
idle one.

**Expected shape:** a net deletion — roughly 45–60 lines out of `index.ts` with
batching retained. A change that grows this file needs an explanation.

**Acceptance:**

| Receiver state | Required result |
| --- | --- |
| idle | exactly one new turn for the batch |
| assistant streaming | delivered after that response, before the next LLM call |
| tool running | tool completes; delivered before the next LLM call |
| core loop ending | Pi's post-run continuation delivers it |
| ≥2 messages within 200 ms | one attributed batch, one iteration |
| messages > 200 ms apart | ordered separate batches |

---

## Task 2 — Remove broadcast messaging

**File:** `index.ts`

Delete the `/link-broadcast` command registration and handler (`:1540-1562`) and
the reference in the header comment (`:10`). Do not replace it.

Also remove chat fan-out: `link_send` no longer accepts `"*"`.

- Drop the `if (params.to !== "*")` wrapper (`:1194-1197`) so the self-target and
  `targetNotFound` guards apply to every send. `"*"` then fails as an unknown
  terminal name, with no special case to write.
- Simplify the result text: there is no longer an "all terminals" target.
- Update the tool and `to` parameter descriptions to say the target is one
  terminal name.

**Keep the hub's internal broadcast.** `hubBroadcast` still carries presence
(`joined` at `:750`, `left` at `:803`), rename (`:1505-1509`), and status updates.
Only `chat` loses fan-out; `ChatMsg.to` becomes always a single name.

This closes the old "broadcast reports success to nobody" gap outright: the
situation is no longer expressible, so no recipient count is needed.

**Acceptance:** `/link-broadcast` is gone from the command list and all docs;
`link_send({to:"*"})` is rejected like any unknown name; presence and status still
reach every terminal.

---

## Task 3 — Defer delivery during compaction

**File:** `index.ts`

Add one module-scoped boolean beside `compactRunning` (`:147`), e.g.
`localCompacting`, with exactly these transitions:

```ts
pi.on("session_before_compact", (event) => {         // manual | threshold | overflow
  setCompacting(true);
  event.signal.addEventListener("abort", () => setCompacting(false), { once: true });
});
pi.on("session_compact",  () => setCompacting(false));  // success
pi.on("agent_start",      () => setCompacting(false));  // Pi resumed normal operation
pi.on("agent_settled",    () => setCompacting(false));  // run finished, nothing pending
// plus a safety deadline inside setCompacting(true)
```

`agent_settled` is not redundant. A **failed auto-compaction** emits neither
`session_compact` nor an abort: `_runAutoCompaction` returns false and the run
simply ends. Without this release the flag would hold messages for the full
deadline for no reason. It cannot clear the flag early, because manual compaction
begins with `await this.abort()`, so `agent_settled` fires *before*
`session_before_compact` sets the flag, and no run can start while the flag holds
the inbox.

The deadline is still required as a last resort: a failed **manual** compaction
emits `compaction_end` only to session listeners, never to extensions, so success
and abort are the only positive endings an extension can observe. Reuse
`COMPACT_TIMEOUT_MS` rather than adding a constant, and keep it generous —
clearing too early means delivering into a compaction, the exact failure this task
prevents.

**Apply it in two places:**

1. `flushInbox` — if `localCompacting || compactRunning`, reschedule and return.
   This is the only remaining reason the inbox defers.
2. The `compact_request` guard (`:614`) — add `localCompacting` so a second
   compaction is declined `busy` rather than started concurrently.

Do **not** handle auto-compaction specially: it runs inside the agent run, so
messages already queue as steering and Pi drains them afterwards.

**Comment the accepted gap at the guard**, briefly: `compact()` aborts and prepares
*before* emitting `session_before_compact`, so a flush in that window can start a
turn against context about to be rebuilt. The message survives — it is persisted
and restored by `buildSessionContext()` — only the turn is wasted. No heuristics to
guess at this window.

**Acceptance:** while compacting, nothing is delivered and no turn starts; when
compaction ends the batch is delivered normally; a remote compact request during
any compaction is declined `busy`; a failed compaction releases the flag within the
deadline.

---

## Task 4 — Correct the compact-timeout result

**File:** `index.ts` (`:1288`)

`COMPACT_TIMEOUT_MS` bounds the caller's wait only; nothing aborts the target,
which usually finishes. Correct the wording, not the mechanism:

> Timed out after 180s; the target may still be compacting. Re-check with
> `link_list` before retrying.

No cancellation machinery, no wire change. A retry arriving while the target still
works now declines `busy` through Task 3, which is the honest answer.

---

## Task 5 — Rewrite the documentation around one model

**Files:** `README.md`, `skills/pi-link-coordination/SKILL.md`,
`../../skills/pi-link-implement-review-commit/SKILL.md` and its
`templates/dispatch-brief.md`, `templates/review-brief.md`,
`templates/commit-brief.md`.

**Teach exactly one mental model:**

> A linked message always demands attention. It steers a running receiver at Pi's
> next safe boundary — current tool calls finish first — or starts a turn on an idle
> one. The sender controls intent through clear content and responsible timing, not
> a transport flag.

**Add the coordination ethic**, since the transport no longer encodes intent:

> Sending to a busy agent means steering its current work. Do it when the message
> should enter that run — a correction, a blocker, a stop, a needed callback. If it
> must not influence the run, wait until the agent is idle.

Corrections, blockers, stop instructions, relevant constraints, and actionable
callbacks are valid steering. Unrelated tasks, courtesy acknowledgements, and
no-effect FYIs should wait. Use ordinary language; do not introduce a mandatory
keyword vocabulary.

**Also state:**

- messages are batched for ~200 ms and attributed by sender;
- a terminal that is compacting receives nothing until it finishes;
- a message needing no action gets no reply — never build acknowledgement loops;
- there is no broadcast: address each peer deliberately, and let that cost
  discipline what you send;
- mixed-version meshes are unsupported during this migration.

**Carry over these rules from the retired doc-accuracy pass.** They were verified
against source and must not be lost:

- **Execution authority travels in the message.** Say plainly what the receiver may
  do — read only, edit these paths, commit — and include the approval itself when
  work depends on one. Never rely on permission that exists only in your own
  conversation.
- **`BLOCKED` is immediate.** A receiver facing unclear authority, a missing input,
  or a failing command replies `BLOCKED` at once, naming what it needs, rather than
  guessing or waiting silently. Material deviations and judgment calls beyond the
  brief are reported with rationale.
- **Send success is not arrival.** For a client, success means the hub accepted the
  message; if the target has vanished, that failure is shown to the human as a
  notification and never reaches the sending model. Treat a missing callback, not a
  send error, as the failure signal, and re-check with `link_list`.
- **Never wait in-turn for a callback.** Replies arrive only as new turns after you
  go idle. Dispatch, finish your turn, let the callback wake you.
- **A busy worker's queue is invisible — do not resend.** If `link_list` shows the
  worker busy, your dispatch is waiting, not lost.

**Remove all templates' `triggerTurn` arguments** (`dispatch-brief.md:3,34,54`,
`review-brief.md:3,29`, `commit-brief.md:3,51`, and the skill's own examples). This
is not cosmetic: if TypeBox rejects the now-unknown property, every dispatch fails.

**Pay for the additions by deleting:**

- the true/false mode tables and all non-waking FYI guidance;
- all broadcast instructions (`/link-broadcast` and `to:"*"` alike);
- explicit-`triggerTurn:true` examples — the tool has no such argument;
- the "callbacks always arrive as clean new turns" claim, no longer true;
- the old compact-race warning telling senders to avoid messaging a compacting
  terminal — Task 3 makes that safe, and the guidance would now be false;
- the duplicated "messages are ephemeral / offline terminals do not receive queued
  work" bullet, already stated under `link_list`;
- "use `/compact` rather than `link_compact` for yourself" — the tool already
  rejects self-targeting with a message that says so, at the moment it matters.

---

## Static gates

Run all of these before handing to review.

```sh
npx --yes esbuild index.ts --bundle --platform=node --format=esm \
  --external:@earendil-works/* --external:ws --external:typebox \
  --external:node:* --outfile=/tmp/pi-link-check.mjs
node --check bin/pi-link.mjs
node test/cli-flags-test.mjs             # 49/49
git diff --check

# Public mode vocabulary, broadcast, and the removed command must be gone:
! rg -n 'triggerTurn|no turn|non-waking|link-broadcast|to: ?"\*"' \
  README.md skills/pi-link-coordination/SKILL.md \
  ../../skills/pi-link-implement-review-commit

# Retired concepts must not reappear:
! rg -n 'link_prompt|Golden Rule' README.md skills/pi-link-coordination/SKILL.md

# Removed schema/wire/plain-append/fan-out paths must not survive under another name:
! rg -n 'params\.triggerTurn|msg\.triggerTurn|triggerTurn:\s*false|deliverAs|link-broadcast|IDLE_RETRY_MS' index.ts

# hubBroadcast must remain, for presence/status only; read every match:
rg -n 'hubBroadcast' index.ts

# Exactly one internal activation should remain; read every match:
rg -n 'triggerTurn:\s*true' index.ts
```

`CHANGELOG.md` and archived plans are deliberately outside the absence gates —
their references are historical.

**No test changes are expected.** `test/cli-flags-test.mjs` covers the launcher
CLI only and references neither `triggerTurn` nor broadcast; nothing else in
`test/` does either. If a test needs editing, say why before editing it.

## Live gates (whole mesh restarted on the same build)

Require an observable read-back for every one. **A subject's single-shot
self-report is not evidence.**

1. idle receiver → exactly one turn;
2. send during a long tool call → tool completes, message read at the next
   boundary, run not aborted;
3. send as a run ends → delivered by continuation, not stranded;
4. three sends inside 200 ms → one wrapped batch, one iteration;
5. sends 1 s apart → ordered separate batches;
6. sender attribution present on every delivery;
7. `link_send({to:"*"})` is rejected as an unknown target, while presence and
   status updates still reach all terminals;
8. `/link-broadcast` is gone;
9. during `/compact` on the target: nothing delivered, no turn starts, batch
   arrives after compaction ends;
10. `link_compact` against a compacting target declines `busy`;
11. all updated skills and templates dispatch successfully.

## Sequencing

1. Three independent plan reviews, each against source rather than prose:
   **opus** (correctness), **fable** (simplicity/value), **sol** (practitioner and
   migration).
2. Owner approves the reviewed plan.
3. Baseline check, then implement Tasks 1–5 as one change.
4. Independent implementation review by a terminal that did not implement.
5. One commit — code, README, both skills, and templates together:
   `feat(pi-link): deliver every linked message on receiver state`
   with a `BREAKING CHANGE:` note that `triggerTurn`, `/link-broadcast`, and
   `to:"*"` fan-out are removed, and that all linked terminals must be upgraded and
   restarted together.
6. Owner restarts the whole mesh; run the live gates.
7. Update `PLAN-roadmap.md`: close the delivery gaps and the P0 compact-race item,
   and record the accepted residual window and the deferred item below.
   (`PLAN-delivery-gaps.md` and `PLAN-doc-accuracy.md` were already deleted when
   this plan absorbed them.)
8. File the upstream Pi report: `compact()` assigns `_compactionAbortController`
   *after* `await this.abort()` (`agent-session.js:1368-1369`) with no reentrancy
   guard, so overlapping compactions clobber the shared field — the
   `reading 'signal'` crash. Evidence and line numbers are in
   `REPORT-compact-race.md`. Task 3 removes pi-link as one participant; it cannot
   fix Pi.

**Owed release note**, to be added when the owner next touches release metadata:

> Upgrade and restart all linked terminals together; mixed-version messaging is
> unsupported.

## Migration hazard

Removing the schema property is a coordinated breaking change:

- TypeBox may reject old calls that still pass `triggerTurn`;
- a new sender omitting the field against an **old** receiver falls into the old
  plain-append branch and delivers silently;
- the orchestration skill and all three templates pass the field today.

Hence one atomic commit, and a whole-mesh restart on the same build.

## Deferred — not abandoned

**Routing failure is invisible to the sending model.** A client's send can report
"sent to hub" from a stale local roster; the hub then fails to route and the
failure surfaces only as a human notification. Task 5 documents this boundary; no
code ships now. If revisited, the candidate direction is to deliver the hub's
existing routing error back to the sender as an ordinary attributed message
through the unified path, which would need proof that it cannot route to itself or
start an error loop. Never receipts, correlation, or blocking RPC.

## Out of scope

- Crash/restart durability for in-memory steering.
- Any change to Pi.
- Delivery receipts or synchronous acknowledgements.
- Reintroducing `link_prompt` or any blocking agent RPC.
- Custom steering, context-event injection, append-and-prove heuristics, or
  duplicate suppression.
- Mandatory message keywords.
- A replacement human broadcast command.
- Versioning, publishing, or release metadata without separate owner approval.
