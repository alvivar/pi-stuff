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

Under Pi's **default** `one-at-a-time` steering mode, `PendingMessageQueue.drain()`
returns only the first message (`agent.js:63-75`), so N queued messages cost N LLM
calls and the 200 ms debounce keeps a burst to one iteration. The user can set
`all` (`agent-session.js:1340`), which drains the whole queue — then the cost
argument disappears but batching still earns its place, because one attributed
wrapper reads as one event instead of N fragments.

### Compaction facts

- Pi already applies the target policy to human input:
  `interactive-mode.js:2478-2489` checks `session.isCompacting` and queues typed
  text instead of submitting it. We extend the same rule to linked messages.
- **Automatic (threshold/overflow) is already correct, and Task 3 must stay out of
  its way.** It runs inside `_runAgentPrompt`, so `_isAgentRunActive` — and
  therefore `isStreaming` (`agent-session.js:588-590`) — stays true: a delivered
  message takes the steering arm, and `_runAutoCompaction` ends with
  `return this.agent.hasQueuedMessages()` under the comment *"Auto-compaction can
  complete while follow-up/steering/custom messages are waiting. Continue once so
  queued messages are delivered."* This is Pi's own design working correctly;
  holding those messages in our inbox instead would replace a working path with
  ours.
- **`session_before_compact` fires for all three reasons**, so Task 3 must filter
  on `reason` rather than gate every compaction.
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
8. **Intent belongs in the message; the skill documents mechanics only.** The
   transport carries no second intent bit, and the guidance prescribes no conduct —
   it states how delivery behaves and lets the model reason from that.
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
- Both mode badges in `renderCall` (`:1231-1234`): `(no turn)` and `(trigger all)`.
  **`:1235` is the message preview and must survive** — deleting through it removes
  the preview from every render.
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

Also remove chat fan-out at **both** ends — the tool and the router:

- Drop the `if (params.to !== "*")` wrapper (`:1188-1197`) so the self-target and
  `targetNotFound` guards apply to every send. `"*"` then fails as an unknown
  terminal name, with no special case to write.
- **Delete the hub's wildcard routing arm** in `routeMessage`
  (`:473-476`: `if (msg.to === "*") { hubBroadcast(msg, msg.from); return true; }`).
  Removing it only from the tool leaves the protocol intact: an old or malformed
  client can still put `to:"*"` on the wire and a new hub will fan it out — which
  is precisely the un-upgraded-sender case the migration section anticipates.
  `routeMessage` accepts only `ChatMsg | CompactRequestMsg | CompactResponseMsg`,
  and neither compact type ever targets `"*"`, so this arm exists solely for chat.
- Remove both `"*"` ternaries: the result text (`:1207`) and
  `renderCall`'s `const target = args.to === "*" ? "broadcast" : args.to` (`:1224`),
  which reduces to `args.to`.
- Update the tool and `to` parameter descriptions to say the target is one
  terminal name.

**Keep the hub's internal broadcast.** `hubBroadcast` still carries presence
(`joined` at `:750`, `left` at `:803`), rename (`:1505-1509`), and status updates,
which the hub mirrors directly (`:758-777`) rather than through `routeMessage`.
Only `chat` loses fan-out; `ChatMsg.to` becomes always a single name.

With the routing arm gone, the old "broadcast reports success to nobody" gap is
closed at the protocol, not merely hidden behind the tool.

**Acceptance:** `/link-broadcast` is gone from the command list and all docs;
`link_send({to:"*"})` is rejected like any unknown name; a `chat` frame carrying
`to:"*"` is not fanned out by a hub; presence and status still reach every
terminal.

---

## Task 3 — Defer delivery during compaction

**File:** `index.ts`

Add one module-scoped boolean beside `compactRunning` (`:147`), e.g.
`localCompacting`, plus one nullable timer handle. **Gate manual compaction only:**

```ts
let localCompacting = false;
let compactDeadline: ReturnType<typeof setTimeout> | undefined;

function setCompacting(on: boolean) {
  localCompacting = on;
  clearTimeout(compactDeadline);                       // never leave a stale deadline
  compactDeadline = on ? setTimeout(() => setCompacting(false), COMPACT_TIMEOUT_MS) : undefined;
  if (!on && inbox.length) scheduleFlush(FLUSH_DELAY_MS);   // release drains; no polling
}

pi.on("session_before_compact", (event) => {
  if (event.reason === "manual") setCompacting(true);   // threshold/overflow are Pi's job
});
// inside the EXISTING handlers, do not register second listeners:
//   pi.on("session_compact", …) at :1093  → setCompacting(false)   // success
//   pi.on("agent_start", …)   at :1086    → setCompacting(false)   // Pi resumed work
```

**Why manual only.** Automatic compaction runs inside the agent run, so a delivered
message takes Pi's steering arm and `_runAutoCompaction` returns
`hasQueuedMessages()` to drain it afterwards. Holding those messages in our inbox
would replace a working Pi path with our own. Filtering on `reason` costs one
clause and removes the need for an `agent_settled` release, whose only purpose was
rescuing a failed auto-compaction we now never gate.

**Why no abort listener.** `event.signal` firing is not an ending: Pi passes that
signal into the summarizer (`agent-session.js:1422`) and
`_compactionAbortController` — the source of `isCompacting` (`:647-651`) — stays set
until the catch/finally (`:1470-1482`). Releasing on abort re-opens delivery while
the aborted compaction is still unwinding. After a cancelled compaction the flag is
released by the user's next run (`agent_start`) or the deadline.

**Why the deadline needs a handle.** A bare `setTimeout` survives its own
compaction: a second compaction starting within `COMPACT_TIMEOUT_MS` would be
released early by the previous deadline. One nullable handle, cleared on every
transition, is essential state, not ceremony. The deadline itself is required
because a failed manual compaction emits `compaction_end` only to session
listeners, never to extensions — and Pi never `.abort()`s the controller on
failure, it only clears it (`:1457`, `:1470`, `:1482`), so success is the sole
positive ending an extension can observe. `COMPACT_TIMEOUT_MS` is reused to avoid a
new constant; note at the use site that the value is shared by coincidence, not by
meaning, since Task 4 rewords the other user of it.

**Apply it in two places:**

1. `flushInbox` — if `localCompacting || compactRunning`, **return without
   rescheduling**. Polling every 200 ms against a compaction that may run to the
   180 s ceiling is ~900 wakeups for no information; the release path above drains
   the inbox instead. This is the only remaining reason the inbox defers.
2. The `compact_request` guard (`:614`) — add `localCompacting` so a second
   compaction is declined `busy` rather than started concurrently.

**Two comments the code must carry**, because both look like redundancy and will
otherwise be "simplified" away:

- `localCompacting || compactRunning` is not duplication. `compactRunning` is set
  synchronously before `ctx.compact()` (`:644-651`), covering the window before
  `session_before_compact` arrives; `localCompacting` covers human `/compact`,
  which pi-link never initiates.
- The flag is load-bearing because Pi will not save us: `AgentSession.prompt()`
  refuses to run during compaction (`agent-session.js:807-809`), but
  `sendCustomMessage` reaches `_runAgentPrompt` directly at `:1090` and is not
  covered by that guard.

**Comment the accepted gap beside the `session_before_compact` handler** — it is a
manual-compaction limitation, not a remote one, since remote compaction is already
gated by `compactRunning`: `compact()` runs `await this.abort()`, auth, and
preparation *before* emitting the event (`agent-session.js:1367-1397`), so a flush
in that window can start a turn against context about to be rebuilt. The message
survives — persisted and restored by `buildSessionContext()` — only the turn is
wasted. No heuristics to guess at this window.

**Acceptance:** during manual `/compact` nothing is delivered and no turn starts;
the batch arrives once compaction ends, without polling in between; a remote
compact request during any compaction is declined `busy`; a cancelled compaction
does not release the gate early; a second compaction is never released by the first
compaction's deadline; automatic compaction is untouched.

---

## Task 4 — Correct the compact-timeout result

**File:** `index.ts` (`:1288`)

`COMPACT_TIMEOUT_MS` bounds the caller's wait only; nothing aborts the target,
which usually finishes. Correct the wording, not the mechanism:

> Timed out after ${COMPACT_TIMEOUT_MS / 1000}s; the target may still be
> compacting. Re-check with `link_list` before retrying.

**Keep the interpolation** the current message already uses — hardcoding "180s"
lets the text drift from the constant. No cancellation machinery, no wire change. A retry arriving while the target still
works now declines `busy` through Task 3, which is the honest answer.

---

## Task 5 — Document the mechanics, not the etiquette

**Files:** `README.md`, `skills/pi-link-coordination/SKILL.md`,
`../../skills/pi-link-implement-review-commit/SKILL.md` and its
`templates/dispatch-brief.md`, `templates/review-brief.md`,
`templates/commit-brief.md`.

**Owner's standard for this task:** the skill states how the transport behaves and
nothing else. No prescribed etiquette, no keyword protocols, no lists of what is
worth interrupting. A capable model derives conduct from accurate mechanics, and
will keep deriving better conduct as models improve; prescriptions freeze today's
judgment into a file that is loaded into every context window forever.

**Test for every sentence:** is this a fact about the system that the reader cannot
observe from inside their own turn? If yes, state it. If it is advice that follows
from such a fact, delete it and make sure the fact is present.

**The mechanics to state** — this is the whole content:

- A message is delivered to the receiver's model. If the receiver is running, it is
  steered in at Pi's next safe boundary — current tool calls finish first, before
  the next LLM call. If the receiver is idle, it starts a turn. There is no way to
  send without entering the receiver's reasoning.
- Messages arriving within ~200 ms are delivered as one batch, in arrival order,
  each labelled with its sender.
- Each send has exactly one recipient. There is no fan-out.
- **Terminals share no conversation.** Nothing in the sender's context — including
  an approval it received — is visible to the receiver. The message is the entire
  shared state.
- A receiver's activity is not observable except through `link_list`; a busy
  terminal's queued messages are invisible to the sender, and silence is
  indistinguishable from work in progress.
- A terminal that is compacting receives nothing until it finishes; the messages
  wait and are delivered afterwards.
- For a client, a successful send means the hub accepted the message, not that it
  arrived. If the target has vanished, the routing failure is shown to the human as
  a notification and never reaches the sending model.
- `link_compact`'s timeout bounds the caller's wait only; the target may still be
  compacting.
- Mixed-version meshes are unsupported: all linked terminals must run the same
  build.

These four facts — delivery always enters the receiver's reasoning, terminals share
no conversation, silence is unreadable, and send success is not arrival — are the
ones every deleted rule was standing in for. State them plainly and the rules are
unnecessary.

**Remove all templates' `triggerTurn` arguments** (`dispatch-brief.md:3,34,54`,
`review-brief.md:3,29`, `commit-brief.md:3,51`, and the skill's own examples). This
is not cosmetic: if TypeBox rejects the now-unknown property, every dispatch fails.

**Delete the orchestrator skill's `link_prompt` and Golden Rule content.** The tool
was removed two releases ago and the policy skill still teaches it at
`pi-link-implement-review-commit/SKILL.md:13-14, 80, 148, 174-177, 193-194` —
including a "sanctioned Golden Rule exception" that instructs the orchestrator to
call a tool that no longer exists. The WAIT state and the no-callback diagnosis
table must be rewritten around `link_send`. The Golden Rule is itself the clearest
example of what this task removes: a prescription that outlived the mechanism that
justified it, and kept being taught. This is the largest single deletion in Task 5.

**Pay for the additions by deleting:**

- the true/false mode tables and all non-waking FYI guidance;
- prescriptive coordination etiquette wherever it appears: what deserves to
  interrupt a busy agent, when to acknowledge, when to stay silent, how quickly to
  report being blocked, and any mandated keyword. Keep the mechanics that make the
  right answer obvious;
- all broadcast instructions (`/link-broadcast` and `to:"*"` alike);
- explicit-`triggerTurn:true` examples — the tool has no such argument;
- the "callbacks always arrive as clean new turns" claim, no longer true;
- the old compact-race warning telling senders to avoid messaging a compacting
  terminal — Task 3 makes that safe, and the guidance would now be false;

When writing the compaction prose, avoid the literal phrase "no turn" — the static
gate below searches for it as a mode term and will trip on innocent sentences like
"no turn starts while compacting." Say "starts nothing" or "waits" instead;
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

# Retired concepts must not reappear — the orchestrator skill is in scope now:
! rg -n 'link_prompt|Golden Rule' README.md skills/pi-link-coordination/SKILL.md \
  ../../skills/pi-link-implement-review-commit

# Removed schema/wire/plain-append/fan-out paths must not survive under another name:
! rg -n 'params\.triggerTurn|msg\.triggerTurn|triggerTurn:\s*false|deliverAs|link-broadcast|IDLE_RETRY_MS|msg\.to === "\*"' index.ts

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
3. send as a run ends → delivered by continuation, not stranded. Method: send
   immediately after the target's last tool result, while its final assistant
   message is still streaming. This interleaving is hard to hit deliberately — if
   three attempts miss the window, record it as best-effort rather than inventing
   instrumentation;
4. three sends inside 200 ms → one wrapped batch, one iteration;
5. sends 1 s apart → ordered separate batches;
6. sender attribution present on every delivery;
7. `link_send({to:"*"})` is rejected as an unknown target, while presence and
   status updates still reach all terminals;
8. `/link-broadcast` is gone;
9. during `/compact` on the target: nothing delivered, nothing starts, batch
   arrives after compaction ends — and no repeated flush attempts in between;
10. `link_compact` against a compacting target declines `busy`;
11. cancel a manual compaction while a message is held: nothing is delivered while
    it unwinds, and the message arrives afterwards;
12. run two compactions inside `COMPACT_TIMEOUT_MS`: the first deadline must not
    release the second;
13. automatic compaction still delivers held messages by Pi's own path;
14. all updated skills and templates dispatch successfully.

## Sequencing

1. Three independent plan reviews, each against source rather than prose:
   **opus** (correctness), **fable** (simplicity/value), **sol** (practitioner and
   migration).
2. Owner approves the reviewed plan.
3. Baseline check, then implement in three reviewable units, each gated,
   independently reviewed, and committed before the next begins:
   - **T-A** = Tasks 1 + 2 — the `index.ts` deletion (trigger modes and broadcast).
     They edit the same functions and adjacent lines; splitting them means two
     passes over one block with line drift in between. Carries the
     `BREAKING CHANGE:` note, since this is where the break occurs:
     `feat(pi-link)!: deliver every linked message on receiver state`
   - **T-B** = Tasks 3 + 4 — the compaction gate and the timeout wording, one
     domain. **Sensitive and serialized**: it enters a freshly compacted window,
     its invariants are restated in both the implement and review briefs, and a
     review deadlock escalates to the owner rather than being tie-broken.
   - **T-C** = Task 5 — documentation, reviewed against the mechanics-only
     standard rather than against code.
4. Independent implementation review of each unit by a terminal that did not
   implement it, reading the uncommitted diff.
5. Per-unit gate is build + tests. The **absence gates over documentation are
   end-state** and run at T-C: between T-A and T-C the docs describe features that
   no longer exist, which is correct, because nothing is deployed until the branch
   is complete.
6. Owner restarts the whole mesh — **one restart, after all three commits** — then
   runs the live gates.
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

Hence **one restart boundary**: no terminal may restart until every unit has
landed, and then the whole mesh restarts together on the same build. The atomicity
requirement is on deployment, not on commit count — the branch is the unit that
ships, so it can be built from several reviewable commits without any terminal ever
running a mixed state.

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
