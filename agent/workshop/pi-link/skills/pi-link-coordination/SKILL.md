---
name: pi-link-coordination
description: Guidance for coordinating work across Pi terminals using link_send, tracking asynchronous callbacks, batching parallel jobs, managing a remote terminal's context with link_compact, and avoiding message loops.
---

# Pi-Link Coordination

How to coordinate work across Pi terminals via pi-link.

Each terminal is an independent agent: terminals share no memory or conversation history. Anything a remote terminal needs — task state, file paths, expected output, and where to send its callback — must be in the message itself.

---

## Tools

### `link_list`

Returns connected terminals with names, live status (`idle`, `thinking`, `tool:<name>`), cwd, and (when available) context usage such as `45K/272K (17%)`. Your own entry is marked `(you)`.

Only connected terminals are visible. If a target is missing, it is offline; messages to offline terminals are not queued. Use `link_list` before dispatch, when selecting among workers, and when an expected callback is missing.

### `link_send`

The agent messaging tool. It returns send/delivery status immediately; it does **not** return the receiver's eventual work result.

Ordinary dispatch omits `triggerTurn` because it defaults to true:

```text
link_send({ to: "worker", message: "... Report DONE or BLOCKED to orchestrator." })
```

Passing `triggerTurn:true` is equivalent. Omitted/true messages enter the receiver's idle-gated inbox and start a turn once the receiver is idle. Nearby messages may be batched into one turn. Delivery is wrapped as `[Link: N message(s) received]` with one `From "name":` block per message.

Use explicit `triggerTurn:false` only for an FYI/status message or intentional live steering that must not start a turn. False delivery bypasses the inbox and arrives immediately as raw content, without the wrapper or sender block. Include sender identity, task tag, and relevant artifact paths in the message body.

Sending to `to:"*"` broadcasts to every other connected terminal. Omitted/true wakes every recipient and can fan out many model turns; use explicit false for an announcement. The human `/link-broadcast` command is always a non-waking announcement and does not request replies.

Sending to yourself is rejected. A definitely absent target fails against the local terminal list; client delivery through the hub remains optimistic.

### `link_compact`

Asks another terminal to compact its context and blocks until completion, with a three-minute ceiling. Busy targets (mid-turn or already compacting) decline rather than being interrupted. Compact a worker predictively while it is idle, before assigning more context-heavy work; after success, dispatch immediately with `link_send`. Optional `instructions` focus the summary.

Use `/compact` rather than `link_compact` for yourself. To compact several idle workers, issue independent calls in parallel.

---

## Dispatch and callback convention

When completion matters, request a tagged callback in the assignment:

- `DONE` or `BLOCKED`
- task/worker identifier
- result summary and artifact paths
- next question or blocker, if any

The callback is another `link_send` message, normally with omitted `triggerTurn` (or explicit true), so it starts a later orchestrator turn at a clean boundary. Callbacks are conventional and uncorrelated: there is no request ID, automatic response, delivery receipt for completed work, or protocol timeout. Track outstanding workers yourself. If a callback is missing, use `link_list` to inspect whether the worker is connected and busy, then follow up explicitly when appropriate.

A receiver should process every `From "name":` block in a batched link message. Send the requested `DONE` / `BLOCKED` callback when work finishes. If a message requires no action, send no reply. Do not acknowledge an acknowledgement unless the sender explicitly asks for one.

---

## Parallel batches

Dispatch independent tasks to several terminals without waiting between sends. Their callbacks may arrive separately or be batched into one orchestrator turn, so maintain an outstanding-worker/task list.

Each assignment must be self-contained:

- identify the task and desired result;
- give explicit paths (absolute when cwd or shared-root assumptions differ);
- state edit/commit constraints;
- state validation commands;
- name the callback recipient and expected `DONE` / `BLOCKED` format.

For dependent work, wait for the prerequisite callback before dispatching its successor. Keep delegation acyclic: asynchronous A → B → C → A chains can loop indefinitely even though no individual send blocks.

---

## Operating constraints

- **Messages are ephemeral.** Offline terminals do not receive queued work.
- **Callbacks are not guaranteed.** They depend on the receiver following the assignment.
- **Localhost only.** All terminals run on the same machine.
- **Cwd is a hint, not proof.** Same cwd does not prove the same workspace, branch, or access. Include explicit paths.
- **Names are identities.** The hub suffixes collisions; use `link_list` to confirm exact names and cwd.
- **Avoid compact races.** Prefer compacting before dispatch or after the worker's callback, not while work is outstanding.
- **Avoid response loops.** Status/FYI messages and acknowledgements that require no action get no reply.

---

## Quick reference

| Need | Use | Behavior |
| --- | --- | --- |
| See connected workers/status/context | `link_list` | Immediate snapshot |
| Delegate work | `link_send({ to, message })` | Async; wakes when idle |
| Delegate with explicit activation | `link_send({ to, message, triggerTurn:true })` | Same as omission |
| Notify or live-steer without waking | `link_send({ to, message, triggerTurn:false })` | Immediate raw steer |
| Wake every other terminal | `link_send({ to:"*", message })` | Async fan-out |
| Announce without waking | `link_send({ to:"*", message, triggerTurn:false })` or `/link-broadcast` | Non-waking fan-out |
| Free an idle worker's context | `link_compact` | Bounded await-completion |
