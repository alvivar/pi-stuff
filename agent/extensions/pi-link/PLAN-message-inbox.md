# Plan: Batched Async Delivery with Idle-Gated Flush

## Problem

`link_send(triggerTurn:true)` calls `pi.sendMessage(triggerTurn:true)` per message. Pi's `sendCustomMessage()` routes this two ways:
- **Agent idle** → `agent.prompt()` — reliable, message IS the prompt
- **Agent busy** → `agent.steer()` — unreliable, message can be stranded if it arrives after the loop's final steering poll but before `agent_end`

Observed: 3 workers send results, 1 silently lost. Root cause documented in `REPORT-sendMessage-race.md`.

## Solution

Receiver-side inbox that collects `triggerTurn:true` messages, then flushes them as ONE batched `sendMessage` call — **only when the agent is idle**. This guarantees the reliable `agent.prompt()` path is always taken.

## Key Insight

`ctx.isIdle()` is available on the extension context (`!isStreaming`). If we gate flushes on `ctx.isIdle() === true`, we avoid the mid-run steer path and its delivery window.

## Scope

- `triggerTurn: true` → inbox + idle-gated batched flush
- `triggerTurn: false` → immediate delivery as today, unchanged

**No protocol changes. No new tools. No breaking changes.**

---

## Delivery Mechanism

### Three flush triggers, one scheduler

```
scheduleFlush(delay):
  clear any existing flushTimer
  set flushTimer = setTimeout(flushInbox, delay)
```

| Trigger | Delay | Purpose |
|---------|-------|---------|
| New message arrives | 200ms | Debounce burst coalescing |
| `agent_end` event | 0ms (next tick) | Wake up when agent becomes idle |
| Idle-gate retry | 500ms | Polling fallback while agent busy |

All three use `scheduleFlush()` — single timer slot, latest call wins (may replace an earlier `0ms` with a `200ms` if a new message arrives, which is fine for coalescing).

### `flushInbox()` logic

```
1. flushTimer = null
2. if inbox empty → return
3. if !ctx.isIdle() → scheduleFlush(500) → return    ← IDLE GATE
4. select batch from inbox (caps: 20 items, 8KB text, 2KB/item)
5. pi.sendMessage(batch, { triggerTurn: true, deliverAs: "steer" })
6. splice sent items from inbox
7. if inbox still has items → scheduleFlush(500)
```

### `agent_end` wakeup

```typescript
// Inside existing agent_end handler:
if (inbox.length > 0) scheduleFlush(0);
```

`agent_end` fires before `finishRun()`, so `ctx.isIdle()` is still false inside the handler. `scheduleFlush(0)` defers to next macrotask when `finishRun()` has completed and idle is true.

---

## State

```typescript
const inbox: { from: string; content: string }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_DELAY_MS = 200;
const IDLE_RETRY_MS = 500;
const BATCH_MAX_ITEMS = 20;
const BATCH_MAX_CHARS = 8000;
const ITEM_MAX_CHARS = 2000;
```

## Batch Format

```
[Link: 3 message(s) received]

From "worker-1":
<content, truncated to 2000 chars>

From "worker-2":
<content>

From "worker-3":
<content>
```

## Cleanup

- **On disconnect**: inbox survives. If non-empty and no timer pending, `scheduleFlush(FLUSH_DELAY_MS)`.
- **On `session_shutdown`**: clear inbox and timer.

## Semantic Change

Messages are delivered **when idle**, not mid-run. For worker results this is ideal — they arrive clean at the start of a new turn. `triggerTurn:false` is unaffected (still immediate/fire-and-forget).

## Expected Outcome

3-worker fan-out test:
1. All 3 results arrive at receiver
2. Each pushed to inbox, debounce resets
3. If agent is idle: 200ms debounce fires → one `sendMessage` → prompt path → all 3 in one turn ✅
4. If agent is busy: wait → `agent_end` fires → `scheduleFlush(0)` → next tick idle → flush → all messages delivered ✅
5. Zero message loss
