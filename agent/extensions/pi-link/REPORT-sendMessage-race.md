# Bug Report: `sendMessage(triggerTurn:true)` can lose messages

## Summary

`pi.sendMessage()` with `triggerTurn: true` can fail to surface messages to the LLM. Observed in pi-link: 3 workers send results back via `link_send(triggerTurn:true)`, consistently 1 of 3 is silently lost.

## Reproduction

1. An extension receives multiple async messages (e.g., from WebSocket callbacks) seconds apart
2. Each calls `pi.sendMessage({ ... }, { triggerTurn: true, deliverAs: "steer" })`
3. One of the messages fails to surface — the LLM never sees it

Observed consistently with pi-link: dispatch 3 parallel tasks to 3 worker terminals, all 3 confirm they sent results back, but only 2 appear at the receiving terminal.

## Likely Root Cause: Late-arriving steer after final poll

Source inspection of `agent-loop.js` reveals a window where steered messages can be orphaned.

### The agent loop's steering poll (agent-loop.js)

```javascript
// Inner loop
while (hasMoreToolCalls || pendingMessages.length > 0) {
    // ... process pending messages, stream response, execute tools ...

    await emit({ type: "turn_end", message, toolResults });
    pendingMessages = (await config.getSteeringMessages?.()) || [];
    // ← steering queue polled HERE
}
// Inner loop exits: no tool calls AND steering queue was empty

// Check follow-ups
const followUpMessages = (await config.getFollowUpMessages?.()) || [];
if (followUpMessages.length > 0) { continue; }

// No follow-ups either → break → agent_end
break;
```

### The window

1. Agent streams a response with no tool calls → `hasMoreToolCalls = false`
2. `getSteeringMessages()` drains the queue → empty at that moment
3. Inner loop exits
4. `getFollowUpMessages()` → empty
5. Loop breaks → `agent_end` emitted → `finishRun()` → `isStreaming = false`

**If `agent.steer(message)` is called between step 2 and step 5**, the message is enqueued in the steering queue but never polled again during this run. It remains queued until a future `agent.prompt()` triggers a new run — which may never come if no further user interaction occurs.

### How this manifests

```
t=0s     Message A arrives → sendCustomMessage(triggerTurn:true)
         agent is idle → agent.prompt(A) → starts run, isStreaming = true

t=2s     Message B arrives → sendCustomMessage → isStreaming = true → agent.steer(B)
         B enters steering queue → will be polled at next turn boundary ✅

t=4s     Agent finishes responding to A (no tool calls)
         Steering queue polled → B is drained and processed ✅
         Agent responds to B (no tool calls)
         Steering queue polled → empty → inner loop exits
         Follow-up queue → empty → agent_end → isStreaming = false

t=5s     Message C arrives → sendCustomMessage(triggerTurn:true)
         agent is idle → agent.prompt(C) → starts new run ✅
         (C works fine)
```

But in the problematic case:

```
t=0s     Message A → agent.prompt(A) → run starts

t=3s     Agent finishes A, no tool calls
         Steering polled → empty
         ─── WINDOW OPENS ───

t=3.01s  Message B arrives → isStreaming still true → agent.steer(B)
         B enqueued in steering queue

t=3.02s  Follow-up check → empty → loop breaks → agent_end
         ─── WINDOW CLOSES ───
         finishRun() → isStreaming = false
         B is STRANDED in steering queue

t=5s     Message C → agent.prompt(C)
         getSteeringMessages() at loop start → drains B!
         Both B and C are now in context ← but B may look stale or out of order
```

In the worst case, if C never arrives and no further user prompt occurs, B is stranded indefinitely. The message is not permanently discarded — it remains in the steering queue and would be drained by a future run — but if no future prompt occurs, it is effectively lost.

## Alternative Hypothesis: Prompt-start race

Initially suspected but less likely: two concurrent `sendCustomMessage(triggerTurn:true)` calls both seeing `isStreaming === false` and racing into `agent.prompt()`. However, `runWithLifecycle()` sets `activeRun` and `isStreaming = true` synchronously before the first `await`, so JS single-threaded execution prevents this specific TOCTOU race under normal conditions.

This remains possible if `sendCustomMessage` is called from within an already-executing async chain (e.g., inside an `await`ed handler), but is less likely than the steering-poll window.

## Impact

Any extension using `pi.sendMessage(triggerTurn:true)` from async callbacks (WebSocket, timers, file watchers) can lose messages when they arrive during the narrow window between the loop's final steering poll and `agent_end`. The caller has no way to detect the failure since `pi.sendMessage()` returns `void`.

## Suggested Fixes

### Option A: Final steering poll before exit (preferred)

Add a last-chance steering drain before breaking the outer loop:

```javascript
// Before breaking outer loop:
const lateSteeringMessages = (await config.getSteeringMessages?.()) || [];
if (lateSteeringMessages.length > 0) {
    pendingMessages = lateSteeringMessages;
    continue;  // re-enter inner loop
}
break;
```

### Option B: Catch-and-steer in sendCustomMessage

Fall back to steering when `agent.prompt()` would fail:

```javascript
else if (options?.triggerTurn) {
    try {
        await this.agent.prompt(appMessage);
    } catch (e) {
        if (this.isStreaming) {
            this.agent.steer(appMessage);
        } else {
            throw e;
        }
    }
}
```

This hardens the prompt-start path but doesn't fix the late-steering window.

### Option C: Both

Apply both fixes for defense in depth.

## Workaround (extension-side)

pi-link mitigates with a receiver-side inbox: incoming `triggerTurn:true` messages are buffered and flushed as a single batched `sendMessage()` after a 200ms debounce. This reduces the number of `sendMessage` calls and the chance of hitting the window, but doesn't fully prevent it for messages arriving seconds apart.

## Environment

- Pi version: 0.65.x
- Extension: pi-link 0.1.7
- Files examined:
  - `pi-agent-core/dist/agent-loop.js` (runLoop, steering poll, follow-up check)
  - `pi-agent-core/dist/agent.js` (prompt, steer, runWithLifecycle, finishRun)
  - `pi-coding-agent/dist/core/agent-session.js` (sendCustomMessage, sendMessage binding)
