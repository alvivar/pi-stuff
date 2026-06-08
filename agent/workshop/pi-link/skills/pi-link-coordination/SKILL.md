---
name: pi-link-coordination
description: Guidance for coordinating work across Pi terminals using pi-link. Use when delegating tasks, choosing between link_prompt and link_send, planning async vs sync work, batching parallel jobs, or avoiding busy/conflict patterns.
---

# Pi-Link Coordination

How to coordinate work across Pi terminals via pi-link.

---

## Tool Selection Rule

- Need the answer back now? → `link_prompt`
- Need autonomous work done? → `link_send(triggerTurn: true)`
- Need to notify only? → `link_send(triggerTurn: false)`

---

## The Golden Rule

> After `link_send(triggerTurn: true)` to terminal X, do not `link_prompt` X until X sends a completion callback.

The `DONE` / `BLOCKED` callback arrives as a normal later user message; treat that callback as the signal that it is safe to send a follow-up `link_prompt`.

Pick one mode per terminal per task. Mixing sync and async on the same terminal is the most common coordination failure.

---

## The Tools

### `link_list`

Returns connected terminals with names, live status (`idle`, `thinking`, `tool:<name>`), and working directory (cwd). Some terminals also report context usage as `45K/272K (17%)` — an advisory signal when choosing a worker (prefer a less-loaded one). Use before delegating when availability or path context is uncertain. Your own entry is marked `(you)` — use this to discover your link name when replying to broadcast tasks.

Only currently connected terminals are visible. If a target is missing, it is offline; messages to offline terminals are not queued.

### `link_prompt`

Synchronous RPC. Send a prompt, wait for the response.

- Fails immediately if target is missing, self, disconnects, or busy (local work or another remote prompt)
- 90s inactivity timeout, 30min hard ceiling
- Remote agent doesn't share your context — include enough detail to complete the task

### `link_send`

Fire-and-forget. Send to one terminal or `to: "*"` to broadcast to every other connected terminal; there is no exclusion filter.

Set `triggerTurn: true` to queue async work on the receiver. The sender does **not** get an automatic response back.

Delivery shape depends on the message's `triggerTurn`:

- **`triggerTurn: true`** messages go through the receiver's idle-gated inbox and surface at a turn boundary wrapped as `[Link: N message(s) received]` followed by one `From "name":` block per message. Multiple pending messages are batched into one turn.
- **`triggerTurn: false`** messages bypass the inbox and surface directly as raw content — no wrapper, no `From` block. The receiver sees only the message text, so the sender must include their own identity, task tag, or artifact paths in the body.

**Callback contract for `triggerTurn: true`:** ask the receiver to reply via `link_send(..., triggerTurn: true)` so the result arrives at a proper turn boundary with the wrapper intact. The reply should include:

- `DONE` / `BLOCKED`
- Output paths / artifacts created
- Result summary or next question

Use `triggerTurn: false` for fire-and-forget status notifications only — when you don't need to act on the reply.

### `link_compact`

Blocks until the target finishes compacting, then returns. Ask another terminal to compact its context window, freeing space. Use when `link_list` shows a worker's context running high: compact it, then — because the call only returns once compaction is done — immediately hand it more work with `link_send`/`link_prompt` (no sleep, no busy-bounce). Busy targets (mid-turn or already compacting) decline; retry when `link_list` shows them idle. You decide the threshold; pi-link only sends the request. When compacting a worker mid-task, pass `instructions` to preserve what it needs to continue (key findings, file paths, open questions, next-step state); otherwise the default summary may drop task state it was relying on.

---

## Operating Constraints

- **One remote prompt at a time per target.** Concurrent requests rejected as busy.
- **No shared context.** Every remote prompt must be self-contained.
- **Messages are ephemeral.** Offline terminals lose messages.
- **Localhost only.** Same machine.
- **Cwd is a hint, not proof.** Same cwd ≠ same workspace/branch/access. Use explicit paths; absolute when cwds differ or shared-root assumptions are unclear.
- **Naming:** Prefer descriptive names such as `role@domain` (e.g., `builder@pi-link`) for coordination. Only talk to your own domain unless told otherwise.

---

## Parallel batch

Distribute independent tasks to multiple terminals via `link_send(triggerTurn: true)`, and keep doing your own work while you wait. Worker callbacks may return together in one batched turn when you become idle. Use explicit paths (absolute if cwds differ), wait for all callbacks, then synthesize. Don't prompt any dispatched terminal until its callback arrives.

---

## Anti-Patterns

**❌ Mixing async and sync on the same terminal**
Dispatched with `link_send(triggerTurn: true)` then sent a `link_prompt` → rejected as busy. See Golden Rule.

**❌ Using `link_send` when you need the response now**
No direct response comes back to the sender. Use `link_prompt` when you need the answer in the same turn.

**❌ Vague prompts**
"Fix the bug" is useless. Include file, line, root cause, expected fix.

**❌ No completion callback on async work**
Always require DONE/BLOCKED + artifact paths + summary.

**❌ Circular delegation**
A → B → C → A = deadlock. Maintain clear hierarchy.

**❌ Skipping `link_list` before retrying a busy target**
Check status before re-sending.

---

## Quick Reference

| I need to...                     | Tool                            | Mode            |
| -------------------------------- | ------------------------------- | --------------- |
| See who's available              | `link_list`                     | —               |
| Get an answer from another agent | `link_prompt`                   | Synchronous     |
| Delegate autonomous work         | `link_send(triggerTurn: true)`  | Asynchronous    |
| Notify without activating        | `link_send(triggerTurn: false)` | Fire-and-forget |
| Broadcast to all                 | `link_send(to: "*")`            | Broadcast       |
