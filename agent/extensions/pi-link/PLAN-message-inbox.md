# Plan: Batched Async Delivery

## Problem

`link_send(triggerTurn:true)` calls `pi.sendMessage(steer)` per message. When multiple arrive near-simultaneously, some can be silently lost — delivery races or LLM attention limits. Observed: 3 workers sent results, only 2 arrived.

## Solution

Receiver-side inbox that collects `triggerTurn:true` messages, then flushes them as ONE batched message after a short debounce.

## Scope

- `triggerTurn: true` → inbox + batched flush
- `triggerTurn: false` → immediate delivery as today, unchanged

**No protocol changes. No new message types. Protocol stays at 9.**

---

## Receiver Side

### State

```typescript
interface InboxItem {
  from: string;
  content: string;
}

const inbox: InboxItem[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_DELAY_MS = 200;
const BATCH_MAX_ITEMS = 20;
const BATCH_MAX_CHARS = 8000;
const ITEM_MAX_CHARS = 2000;
```

Order is preserved by array insertion — no timestamp needed.

### On receive `chat` with `triggerTurn: true`

1. Push `{ from, content }` into `inbox`
2. Clear existing `flushTimer`, set new one for `FLUSH_DELAY_MS`

### On receive `chat` with `triggerTurn: false`

Immediate delivery as today. No inbox.

### Flush

1. If `inbox` is empty → return
2. Take items from front: up to `BATCH_MAX_ITEMS`, total text under `BATCH_MAX_CHARS`
3. Compose one batched message (see format below)
4. `pi.sendMessage(batch, { triggerTurn: true, deliverAs: "steer" })` — handoff to Pi
5. Remove those items from `inbox` (only after handoff)
6. If `inbox` still has items → schedule another flush

### Batch format

```
[Link: 3 message(s) received]

From "worker-1":
<content, truncated to 2000 chars>

From "worker-2":
<content>

From "worker-3":
<content>
```

- Ordered by arrival (array order)
- Per-item truncated at `ITEM_MAX_CHARS` with `... (truncated)` suffix
- Total text capped at `BATCH_MAX_CHARS` — stop adding items when next would exceed
- Blank line between items

### Cleanup

**On link disconnect**: do NOT clear `inbox` or cancel `flushTimer`. Messages are local state waiting for local delivery. If inbox is non-empty and no timer is pending, schedule a flush immediately.

**On `session_shutdown`**: clear everything.

---

## Implementation

Single batch — small change, ~40-60 lines:

1. Add `inbox[]`, `flushTimer`, constants
2. In `chat` + `triggerTurn:true` handler: push to inbox, schedule flush (replace current `sendMessage` call)
3. Add `flushInbox()` function: select batch, compose, deliver, clear, reschedule
4. Update disconnect/shutdown cleanup
5. Update README/CHANGELOG

---

## Expected Outcome

The 3-worker test case:

1. All 3 results arrive at receiver within milliseconds
2. Each pushed to `inbox`
3. 200ms debounce coalesces all 3
4. ONE batched message delivered
5. LLM sees all 3 in a single context entry
6. Zero message loss
