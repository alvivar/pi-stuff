# Plan: Heartbeat-Based Prompt Timeout (C-prime)

Replace the fixed 2-minute `link_prompt` timeout with an inactivity-based timeout that resets on proof-of-life from the target terminal.

## Problem

The current 2-minute hard timeout causes false failures on long agent tasks. The calling LLM interprets timeout as failure, retries, creates duplicate work. A single long `bash` or thinking step can easily exceed 2 minutes while being perfectly healthy.

## Design

Two mechanisms working together:

### Target side: periodic keepalive while executing a remote prompt

While `pendingRemotePrompt` is active, send a `status_update` every `KEEPALIVE_INTERVAL_MS` (30s). This guarantees the sender sees regular proof-of-life even during long single-tool executions with no state transitions.

- Start interval on `prompt_request` acceptance (when `pendingRemotePrompt` is set)
- Clear interval on `agent_end` (when response is sent) or on disconnect/cleanup
- Reuses existing `status_update` message — no new protocol message type

### Sender side: inactivity timeout + hard ceiling

Replace the single `PROMPT_TIMEOUT_MS` with two timers per pending prompt:

- **Inactivity timeout** (`PROMPT_INACTIVITY_MS`, 90s): resets every time a `status_update` arrives from the target terminal. Fires only after sustained silence.
- **Hard ceiling** (`PROMPT_HARD_CEILING_MS`, 30 minutes): never resets. Safety net against broken-but-chatty targets.

When either fires, resolve the pending prompt with a timeout error.

## Constants

```ts
const KEEPALIVE_INTERVAL_MS = 30_000;    // target sends keepalive every 30s
const PROMPT_INACTIVITY_MS = 90_000;     // sender times out after 90s of silence
const PROMPT_HARD_CEILING_MS = 1_800_000; // sender hard ceiling: 30 minutes
```

## Changes to `pendingPromptResponses`

Current shape:
```ts
Map<string, { resolve, timeout }>
```

New shape:
```ts
Map<string, {
  resolve,
  targetName: string,
  inactivityTimeout: ReturnType<typeof setTimeout>,
  ceilingTimeout: ReturnType<typeof setTimeout>,
}>
```

---

## Batch 1 — Target keepalive

Add periodic status push while executing a remote prompt.

### Steps

1. Add a `keepaliveTimer: ReturnType<typeof setInterval> | null` state variable
2. When `pendingRemotePrompt` is set (in `handleIncoming("prompt_request")`):
   - Start interval: `keepaliveTimer = setInterval(() => pushStatus(true), KEEPALIVE_INTERVAL_MS)`
   - `force: true` ensures the status is sent even if the derived status hasn't changed
3. When `pendingRemotePrompt` is cleared (in `agent_end` handler):
   - `clearInterval(keepaliveTimer); keepaliveTimer = null`
4. In `disconnect()` cleanup:
   - `clearInterval(keepaliveTimer); keepaliveTimer = null`
   - Also clear `pendingRemotePrompt = null` (already happens implicitly since we don't clean it today — verify)

### Edge cases
- **Prompt rejected (busy):** No keepalive timer started. Correct — nothing to keep alive.
- **Defensive start:** Always `clearInterval(keepaliveTimer)` before starting a new one, even though double-start should be impossible.
- **`disconnect()` must explicitly:** `clearInterval(keepaliveTimer); keepaliveTimer = null; pendingRemotePrompt = null;` — hard requirement, not optional.

### Output
Target sends regular `status_update` messages every 30s while working on a remote prompt.

---

## Batch 2 — Sender inactivity timeout

Replace fixed timeout with inactivity + ceiling on the sender.

### Steps

1. Remove `PROMPT_TIMEOUT_MS` constant (replaced by the two new constants)
2. In `link_prompt` execute:
   - Create `inactivityTimeout` (90s) — on fire: resolve with inactivity timeout error, clean up
   - Create `ceilingTimeout` (30min) — on fire: resolve with hard ceiling error, clean up
   - Store `{ resolve, targetName: params.to, inactivityTimeout, ceilingTimeout }` in `pendingPromptResponses`
3. Add a helper `resetInactivityFor(targetName: string)`:
   - Iterate `pendingPromptResponses` entries
   - For any entry where `targetName` matches, clear old `inactivityTimeout` and create a new one
   - The timeout handler logic should live in a small factory/helper (`makeInactivityTimeout(requestId, targetName)`) so initial setup and reset share the same code — no duplication
4. In `handleIncoming("status_update")`:
   - After `terminalStatuses.set(msg.name, msg.status)`, call `resetInactivityFor(msg.name)`
5. On the hub, in the `hubHandleClient` status fan-out path:
   - After `hubTerminalStatuses.set(...)`, call `resetInactivityFor(clientName)`
   - (Hub may also be a sender waiting for a prompt response)
6. Update abort handler: clear both `inactivityTimeout` and `ceilingTimeout`
7. Update `disconnect()` cleanup: clear both timeouts for all pending entries
8. Update `handleIncoming("prompt_response")`: clear both timeouts when response arrives

### Cleanup contract
Every resolution path (response, inactivity, ceiling, abort, disconnect) must:
1. Clear `inactivityTimeout`
2. Clear `ceilingTimeout`
3. Delete the entry from `pendingPromptResponses`
4. Resolve the promise exactly once

Target-side cleanup (in `disconnect()` and `agent_end`):
5. `clearInterval(keepaliveTimer); keepaliveTimer = null`
6. `pendingRemotePrompt = null`

Late arrivals (status_update or prompt_response after resolution) find no pending entry and silently no-op.

### Output
Sender timeout is now activity-aware. Long healthy tasks don't timeout. Silent targets timeout in 90s.

---

## Batch 3 — Update `broadcast_prompt` plan

The `PLAN-broadcast-prompt.md` references `PROMPT_TIMEOUT_MS` for per-target timeouts. Update it to use the new inactivity + ceiling model. Same `resetInactivityFor` function works — it resets timers for all pending prompts to a given target, regardless of whether they came from `link_prompt` or `link_broadcast_prompt`.

### Steps

1. Update `PLAN-broadcast-prompt.md` to reference `PROMPT_INACTIVITY_MS` and `PROMPT_HARD_CEILING_MS` instead of `PROMPT_TIMEOUT_MS`
2. Note that `resetInactivityFor` handles broadcast entries automatically (same map, same target matching)

### Output
Broadcast prompt plan is consistent with new timeout model.
