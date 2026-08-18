# PLAN — Coordination doc accuracy pass

> **Status:** Ready for review (owner has not approved execution yet)
> **Last aligned:** 2026-07-17
> **Build from this?** Yes, once the owner approves. Docs only — no code changes.
> **Summary:** The coordination skill and README describe sends that always
> succeed and messages that always arrive. Three independent reviews (fable,
> opus, sol) found four places where the code does not keep those promises, and
> two rules the async-only change made necessary but nobody wrote down.

## Why this exists

`skills/pi-link-coordination/SKILL.md` is loaded by every pi-link terminal. It is
the only guidance most agents will ever read about how messaging behaves, and
they cannot verify any of it. When it overstates a guarantee, a model makes a
confident wrong decision and there is no error to correct it.

The four inaccuracies below were verified against `index.ts` at `f1b1042` and
against Pi 0.80.3's own session code. They are documentation defects, not
regressions: the async-only change (`0338ee5`) is live-validated and correct.
The doc simply describes it inaccurately.

Root cause worth stating once, because it explains all four: **the doc describes
the send succeeding and lets the reader infer the receive happened.** Those come
apart in several independent ways.

## Task 1 — Correct the four inaccurate claims

**File:** `skills/pi-link-coordination/SKILL.md`

### 1.1 "Arrives immediately" is false for an idle receiver

**What it says now:** "False delivery bypasses the inbox and arrives immediately
as raw content."

**What the code does:** `link_send` passes `triggerTurn:false` explicitly
(`index.ts:600-608`). In Pi 0.80.3 that makes `sendCustomMessage` skip the
steering branch entirely (`agent-session.js:1078-1096`) — `agent.steer()` is
never called and `deliverAs:"steer"` has no effect on this path. The message is
appended to the receiver's message state. A **mid-run** receiver picks it up in
that run; an **idle** receiver starts no turn at all, so the message waits until
some later, unrelated turn begins. It may never be read.

Our own live test showed this and we misread it as a clean pass: test2 confirmed
the message was present but that nothing woke it until a separate question
arrived much later.

**Fix:** replace with wording that splits the two cases:

> False delivery bypasses the inbox and is appended to the receiver's message
> state immediately, without the wrapper or sender block. A receiver that is
> mid-run normally picks it up during that run. **A receiver that is idle starts
> no turn — the message waits in its context until some later turn begins, and
> may never be read.** Use false to steer work already in progress; do not use it
> to tell an idle terminal something you need it to act on.

### 1.2 A client's send can report success and reach nobody

**What it says now:** "A definitely absent target fails against the local
terminal list; client delivery through the hub remains optimistic."

**What the code does:** `targetNotFound` checks only the local cache
(`index.ts:1137-1144`). If the name is cached but the terminal has left, a
client's `routeMessage` returns true (`:511-513`) and the tool reports success.
The hub's routing failure comes back as an error message (`:487-497`) which the
client renders as a **human-facing notification** (`:687-689`). It is never a
tool result, so the sending model never learns.

**Fix:** keep the mechanism sentence, add the consequence:

> Sending to yourself is rejected, and a definitely absent target fails against
> your local terminal list. **But if you are a client rather than the hub, a
> successful result only means the hub accepted the message — if the target has
> vanished, that failure is shown to the human as a notification and never
> reaches you.** Treat a missing callback, not a send error, as your failure
> signal, and re-check with `link_list`.

### 1.3 The compact-race warning names the wrong actor

**What it says now:** "Avoid compact races. Prefer compacting before dispatch or
after the worker's callback, not while work is outstanding."

**What the code does:** `flushInbox` gates on `ctx.isIdle()` (`index.ts:355-365`),
which is `!_isAgentRunActive` (`agent-session.js:592-593`). Compaction never sets
that flag — it is surfaced by a separate `isCompacting` getter (`:647-651`). So a
compacting terminal looks idle, the inbox flushes, and a fresh turn starts against
context the compaction is about to replace.

The current bullet misses both the failure itself and the real trigger: **any**
inbound waking message from **any** terminal, not just outstanding work of yours.

**Fix:** replace the bullet with an actionable rule:

> **Never send to a terminal while your `link_compact` on it is still
> outstanding.** A message landing during compaction starts a turn on the target
> anyway — the idle check does not know compaction is running — and that turn
> runs against context the compaction is about to replace. `link_compact` blocks
> for exactly that window: wait for it to return before dispatching.

### 1.4 Restore the compact-timeout caveat lost in the rewrite

**What it says now:** "blocks until completion, with a three-minute ceiling."

**What the code does:** on timeout the *call* resolves with an error
(`index.ts:1288-1293`), but nothing aborts the target — its compaction continues
and often succeeds. The pre-rewrite skill said this; the rewrite dropped it.

**Fix:** append:

> A timeout means your call gave up, not that the target stopped — it may still
> finish. Re-check with `link_list` before assuming failure or retrying.

## Task 2 — Add the two missing rules

**File:** `skills/pi-link-coordination/SKILL.md`

### 2.1 You cannot wait in-turn for a callback

Removing `link_prompt` did not only delete a tool — it removed **waiting** as a
valid strategy. Nothing reaches an agent mid-turn except explicit-false delivery,
so an agent that dispatches and then lingers, polling `link_list` for a reply,
waits forever and burns tokens doing it. This is the direct consequence of the
change we shipped and it is written down nowhere.

Add to `## Dispatch and callback convention`, after "Track outstanding workers
yourself.":

> Never wait in-turn for a callback: replies arrive only as new turns after you go
> idle. Dispatch, finish your turn, and let the callback wake you.

### 2.2 Execution authority travels in the message

The most expensive failure this project has hit: a worker received a task but no
authority to act, and waited silently because terminals share no conversation and
it could not infer permission. Both sides need a rule, and both sides are covered
by this shared skill.

Add at the start of `## Dispatch and callback convention`:

> **Execution authority travels in the message.** Say plainly what the receiver
> may do — read only, edit these paths, commit — and include the approval itself
> when work depends on one. Never rely on permission that exists only in your own
> conversation. A receiver facing a mutation request with unclear authority must
> not guess or wait silently: reply `BLOCKED` and name the approval needed.

Deliberately **not** adopted: a `GO / REVIEW / HOLD` keyword vocabulary. It adds
three tokens of ceremony for a rule that plain language already carries.

Also extend the callback contract in the same section:

> - material deviations or judgment calls beyond the brief, with rationale;

and add:

> If you cannot start or continue, send `BLOCKED` immediately with the missing
> input, failing command, or decision needed. Do not sit idle waiting for the
> sender to notice.

### 2.3 A busy worker's queue is invisible — do not resend

Add to `## link_send`, after the inbox sentence:

> Messages to a busy terminal queue invisibly and land at its next turn boundary.
> If `link_list` shows the worker busy, your dispatch is waiting, not lost — do
> not resend.

## Task 3 — Cut restatement that the tool descriptions already carry

**File:** `skills/pi-link-coordination/SKILL.md`

This file is loaded into every context window, so the additions above should be
paid for. Cut:

1. "Passing `triggerTurn:true` is equivalent." and the matching quick-reference
   row "Delegate with explicit activation" — the schema already states the
   default, and the row describes an argument nobody should pass.
2. The constraints bullet "**Messages are ephemeral.** Offline terminals do not
   receive queued work." — duplicated in `link_list`, where the reader is already
   being told to check before dispatch.
3. "Use `/compact` rather than `link_compact` for yourself." — the tool rejects
   self-targeting with a message that says so, at the moment it matters.

Do **not** cut the absent-target sentence or the batching sentence: 1.2 expands
the first, and the second is the only place the wrapper shape is explained.

**Net effect:** roughly seven lines out, roughly nine in. Length stays flat.

## Task 4 — Sweep the README for the same claims

**File:** `README.md`

The README was rewritten in the same commit and likely repeats 1.1 and 1.3.
Check every statement about false delivery, "immediate" steering, and compaction,
and apply the same corrections. Do not restate the whole skill in the README —
correct what is wrong and leave the rest.

## Gates

Docs only. No code, no version, no CHANGELOG, no package changes.

```sh
rg -n 'immediately|immediate' skills/pi-link-coordination/SKILL.md README.md
rg -n 'link_prompt|Golden Rule' skills/pi-link-coordination/SKILL.md README.md   # must stay empty
git diff --check
```

Read the result end to end: it must teach one mental model, and every behavioral
claim must be one an agent can rely on.

## Sequencing

Tasks 1–4 are one docs change and land as a single commit — a partial pass would
leave the two files disagreeing with each other.

1. Implement Tasks 1–3, then Task 4.
2. Independent review against `index.ts` (the reviewer must differ from the
   implementer, and must check claims at source rather than reading prose).
3. One commit: `docs(pi-link): correct delivery guarantees in coordination guidance`.

## Out of scope

The underlying behaviors are not changed here — only described accurately.
Whether any of them *should* change is tracked separately in
`PLAN-delivery-gaps.md`.
