---
name: pi-link-coordination
description: Mechanics of coordinating work across Pi terminals with link_send, link_list, and link_compact — how delivery, batching, callbacks, and remote compaction actually behave.
---

# Pi-Link Coordination

How the pi-link transport behaves between Pi terminals.

**Terminals share no conversation.** Each is an independent agent with its own
context. Nothing you hold — task state, file paths, an approval you were given,
what you decided a moment ago — is visible to a terminal you message. The message
is the entire shared state.

---

## Tools

### `link_list`

Returns connected terminals with names, live status (`idle`, `thinking`,
`tool:<name>`), cwd, and (when available) context usage such as `45K/272K (17%)`.
Your own entry is marked `(you)`.

Only connected terminals are visible. Messages to a terminal that is not connected
are not queued anywhere; they are dropped.

A terminal's activity is not observable by any other means. Its queued messages
are invisible to you, and silence is indistinguishable from work in progress.

### `link_send`

```text
link_send({ to: "worker", message: "..." })
```

The message is delivered to the receiver's model. Messages arriving within ~200ms
are held and delivered as one batch, in arrival order, each labelled with its
sender: a `[Link: N message(s) received]` block containing one `From "name":` block
per message.

The receiver's state is read when that batch is delivered, not when you send and
not when you last ran `link_list`. If the receiver is still running then, the batch
is steered into that run at Pi's next safe boundary — current tool calls finish
first, before the next LLM call. Otherwise it starts a turn. A receiver can settle
within the delay, so a message sent to a busy terminal may still arrive as a new
turn. There is no way to send without entering the receiver's reasoning.

Each send has exactly one recipient. There is no fan-out.

The call returns send status, not the receiver's eventual work result. Sending to
yourself is rejected. A definitely absent target fails against the local terminal
list; beyond that, for a client a successful send means the hub accepted the
message, not that it arrived. If the target has vanished, the routing failure is
shown to the human as a notification and never reaches the sending model.

A terminal that is compacting receives nothing until it finishes. The messages wait
and are delivered afterwards.

### `link_compact`

Asks another terminal to compact its context and blocks until it completes, with a
three-minute ceiling. Targets that are mid-turn or already compacting decline
rather than being interrupted. Optional `instructions` focus the summary.

The timeout bounds your wait only. Nothing aborts the target, so a timed-out call
may mean the compaction is still running.

Compaction discards detail. What survives is whatever the summary keeps, so
anything the target learned but has not written down or reported can be lost.

---

## Callbacks

A callback is an ordinary `link_send` from the worker back to you. There is no
request ID, no automatic response, no delivery receipt, and no protocol timeout —
nothing correlates a callback with the dispatch that asked for it except the text
of both, and nothing produces one except the receiver choosing to send it.

An accepted send does not wait for a reply, so several tasks can be dispatched
before any callback arrives, and callbacks may arrive separately or batched into
one of your turns. For the same reason the protocol supplies no exit condition for
an A → B → C → A delegation chain.

---

## Constraints

- **Localhost only.** All terminals run on the same machine.
- **Cwd is a hint, not proof.** Same cwd does not prove the same workspace, branch,
  or access.
- **Names are identities.** The hub suffixes collisions, so the name you remember
  may not be the name that is connected; `link_list` shows the current one.
- **Mixed-version meshes are unsupported.** All linked terminals must run the same
  build.
