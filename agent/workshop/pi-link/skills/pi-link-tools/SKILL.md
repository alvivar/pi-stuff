---
name: pi-link-tools
description: "How to work with other Pi terminals over pi-link: link_list, link_send and link_compact, replying, waiting and remote compaction."
---

# Pi-Link Tools

pi-link connects Pi terminals on this machine. Each terminal has its own conversation, tools and access; messages do not share conversation history or tool access automatically. `link_list` shows who is connected, `link_send` delivers a message to one terminal, and `link_compact` asks one to compact its context; both target one other terminal, never yourself. The tools cannot connect or rename a terminal: that is done locally with `/link-connect` and `/link-name`, so if a tool reports not connected, tell the user.

## Who is there: `link_list`

- Takes no arguments. Lists the terminals in your group with status (`idle`, `thinking`, `compacting`, `tool:<name>`), cwd and context usage as tokens used/window. Your own entry is marked `(you)`; that name is how others reach you.
- Values are snapshots: an idle terminal may be busy by your next call. A missing status or `?` usage means unknown, not idle or empty; usage is often unknown right after a compaction. `compacting` means incoming messages and outcomes are held; it does not prove compaction is still running.
- The group is the text after the first `@` in a name; an absent or empty group suffix means the shared ungrouped group. The tools only see and reach your own group. Groups filter visibility; they are not access or trust boundaries.

## Sending: `link_send`

- Required string arguments: `to` is the exact name from `link_list`; `message` is the text. A name not in your list is rejected, not queued. The message is delivered into the other terminal's reasoning: it starts a turn if the terminal is idle, or steers the running one at its next safe boundary, after its current tool calls finish.
- The receiver gets only your message. Include the context it needs, explicit paths or the intended cwd — naming a path does not change its cwd — and who should receive the result.
- A successful send means the message was handed to the link, not that it arrived or was read; a later failure may be shown only to the human, and a message lost in transit is not replayed. Ask for a reply when you need confirmation, and label concurrent exchanges when needed.

## Receiving, replying and waiting

- Received batches start with `[Link: N message(s) received]`; each chat has its own `From "<name>":` block, in arrival order. A batch may mix senders and compaction outcomes. Keep each request and its reply destination distinct.
- Your ordinary reply stays in your own conversation. Send results with `link_send` to the requester or the designated recipient. For ordinary messages, pi-link generates no reply, receipt, request ID or reply timeout.
- Replies and outcomes arrive through the same delivery path, so if all that remains is waiting, end your turn; sleeping or polling `link_list` can delay delivery until your tool calls finish. Continue useful work if you have it. Silence does not tell you whether a message was received or acted on.
- Do not reply just to acknowledge an acknowledgment: each delivered message starts or steers work.

## Remote compaction: `link_compact`

- `to` is a required string naming the target; `instructions` is optional text saying what the summary should preserve. Compaction summarizes the target's older conversation; it is not a task and starts no work turn, and `instructions` do not guarantee what survives. Have details that matter reported or written down first: a task sent just before is not guaranteed to be processed before the compaction.
- The call returns as soon as the request is sent, with a request ID; sent confirms neither acceptance nor completion, and a failure before sending produces no outcome. The target waits, with no deadline, until Pi reports it idle and it no longer reports `compacting`, then compacts; you need not check for idle first. Idle is observed, not reserved: work that starts as compaction begins can still be interrupted. Older targets may decline busy requests instead of waiting.
- A target holds one request at a time, waiting or running, from any requester; another is declined, not queued. You can have requests outstanding to several targets.
- Each request produces at most one outcome, generated automatically and delivered to your inbox as one line, `link_compact "<target>" [<id>]: <outcome>`, with no `From` header; match the target and ID to your sent request. `compacted` confirms success; `not done: <reason>` reports a decline or failure, not retried; a notice saying `result unknown` ends tracking without confirmation and does not prove compaction failed.
- There is no remote cancel: leaving does not undo a request the target holds. Reloading or exiting loses tracking of pending outcomes, renaming can lose responses, and a lost response is not replayed and can leave a request unanswered indefinitely; `link_list` cannot recover it.

## Shared files

- Terminals may share files and pi-link does not lock them: agree who edits before concurrent changes.
