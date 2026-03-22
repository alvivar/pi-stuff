# Code Review: `agent/extensions/pi-mesh`

## Summary

This is a nice, compact extension overall: the core idea is easy to follow, the protocol is small, and the use of discriminated message types keeps most of the file readable.

The biggest improvement area is **simplifying the control flow** around routing, naming, and connection discovery. Right now a few branches make the implementation look simpler than it behaves: some failures are only surfaced in the UI, some state is duplicated, and one of the discovery mechanisms is effectively unused.

I’d prioritize the following.

---

## Findings

### 1. Missing recipients are not reported back to the calling tool correctly

**Priority:** High
**Area:** Simplicity / behavior
**Lines:** `index.ts:185-219`, `index.ts:287-315`, `index.ts:682-729`

`routeMessage()` handles an unknown `msg.to` by either:

- showing a local UI warning, or
- sending a generic `error` message back to the sender.

That creates two bad outcomes:

- `mesh_send` still returns `Sent to "..."` even when nothing was delivered.
- `mesh_prompt` does **not** receive a `prompt_response` error, so the caller waits the full 120 seconds and times out instead of failing fast.

This is especially visible when a client prompts a non-existent terminal: the hub emits `error`, but `pendingPromptResponses` only resolves on `prompt_response`.

### Recommendation

Make routing failures part of the normal request/response path instead of a side-channel UI notification.

Concretely:

- For `prompt_request`, synthesize an immediate `prompt_response` with `error` when the target is missing.
- For `chat`, let `routeMessage()` return a delivery result (or throw) so `mesh_send` can return an honest tool result.

That will make the behavior much simpler for both users and the LLM.

---

### 2. Hub renaming bypasses the uniqueness rules and can make routing ambiguous

**Priority:** High
**Area:** Simplicity / correctness
**Lines:** `index.ts:152-157`, `index.ts:850-861`

Name deduplication exists in `uniqueName()`, but it is only used during client registration. The `/mesh-name` command for the hub does this instead:

```ts
terminalName = newName;
```

If a client is already using that name:

- `terminalList()` collapses duplicates because it is built from a `Set`
- direct sends can be routed to the hub instead of the client (`msg.to === terminalName` wins first)
- one of the terminals effectively becomes unreachable by name

### Recommendation

Run hub renames through the same uniqueness path as registration, or centralize all renaming through one shared function.

Even better: make the hub authoritative for _all_ name changes, including its own, so there is only one code path that enforces uniqueness and updates `connectedTerminals`.

---

### 3. The temp mesh file is currently unnecessary complexity

**Priority:** Medium
**Area:** Unnecessary code / simplicity
**Lines:** `index.ts:36-37`, `index.ts:400-405`, `index.ts:478-485`

The extension writes and reads `pi-mesh.json`, but today:

- the host is always `127.0.0.1`
- the port is always `DEFAULT_PORT`
- the stored `pid` is never used

So the file does not currently enable discovery of anything dynamic. Clients could just try `ws://127.0.0.1:9900` directly, which already happens after the read anyway.

### Recommendation

Either:

1. remove the mesh file entirely, or
2. make it pull its weight by supporting dynamic port selection and/or validating whether the recorded PID is still alive.

As written, this is extra I/O and extra state to reason about without a real payoff.

---

### 4. Too much unrelated responsibility lives in one file and a few helpers are duplicated

**Priority:** Medium
**Area:** Simplicity
**Lines:** broadly `index.ts:1-908`

`index.ts` currently owns:

- protocol types
- hub/client socket lifecycle
- routing
- prompt orchestration
- Pi lifecycle hooks
- tool definitions
- command definitions
- renderer definitions

On top of that, several patterns repeat:

- identical `Not connected to mesh` tool results
- repeated preview truncation logic in tool renderers
- repeated result shaping for text-only tool responses

None of this is individually bad, but together it makes the file harder to change safely than it needs to be.

### Recommendation

Split by concern, even if only lightly:

- `protocol.ts` for message types
- `transport.ts` or `mesh.ts` for hub/client/routing
- `tools.ts` for tool registration
- shared helpers for `notConnectedResult()` and `truncatePreview()`

That would reduce the branching density and make the naming/routing bugs easier to spot.

---

### 5. A few `any` casts and ad-hoc result types weaken an otherwise typed implementation

**Priority:** Low
**Area:** Idiomatic TypeScript
**Lines:** `index.ts:123-128`, `index.ts:577-580`, `index.ts:747-748`, `index.ts:798-800`, `index.ts:902`

The file is mostly typed well, but a few places fall back to `any` or hand-written inline shapes:

- assistant content extraction uses `(c: any)`
- renderer reads `(message.details as any)?.from`
- pending tool result resolution uses an inline object type instead of a shared alias/interface

### Recommendation

Introduce small local types instead of dropping to `any`, e.g.:

- a typed helper for extracting assistant text blocks
- a `MeshToolResult` alias
- a typed `details` object for mesh-rendered messages

This would make the code more idiomatic without adding much verbosity.

---

### 6. “First message must be register” is documented in code comments but not enforced

**Priority:** Low
**Area:** Simplicity / robustness
**Lines:** `index.ts:328-362`

The comment says:

> First message must be register

But the handler does not actually enforce that. Any unregistered socket can send `chat`, `prompt_request`, or `prompt_response`, and the hub will route it.

Even for a localhost-only tool, this is a confusing mismatch between the intended protocol and the implementation.

### Recommendation

Short-circuit non-`register` messages until `clientName` has been established, or close the socket immediately if the first frame is not a valid registration.

That is both simpler and more honest to the protocol.

---

## Performance notes

No major performance problems stood out for the intended scale of “a few terminals on localhost”. The main thing I’d watch is that directed sends do repeated linear scans of `hubClients` (`index.ts:194-218`).

That is fine at this size, but if you want a small cleanup that also improves performance, keep a second map of `name -> WebSocket` (or make the hub’s client registry a richer object keyed by name). That would also simplify the target-not-found handling.

---

## Overall

I would address the review in this order:

1. Fix missing-target behavior for `mesh_send` / `mesh_prompt`
2. Fix hub rename deduplication
3. Remove or justify the mesh temp file
4. Extract a few helpers / split responsibilities
5. Clean up the remaining `any` usage

The extension is already small enough to improve quickly; the biggest wins are mostly about removing hidden behavior rather than adding features.
