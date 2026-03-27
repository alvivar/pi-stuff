# Plan: `link_broadcast_prompt`

Send a prompt to all terminals on the link and collect all responses.

## Design Decisions

- **New tool** (`link_broadcast_prompt`), not an extension of `link_prompt` — different return shape (map vs single), different timeout semantics (wait for all), cleaner for LLM tool selection.
- **No slash command yet** — prove the tool first, add `/link-broadcast-prompt` later if useful interactively.
- **No new protocol messages** — reuse existing `prompt_request` / `prompt_response`. Send N individual requests, one per target.
- **Partial failure is normal** — terminals can timeout, error, or be busy. The result captures all outcomes.

## Response Shape

```ts
// content (human-readable summary)
"Collected 3/4 responses (2 ok, 1 timeout, 1 error)"

// details (structured, machine-readable)
{
  responses: {
    [name: string]: {
      status: "ok" | "error" | "timeout";
      response?: string;
      error?: string;
    }
  },
  total: number,
  ok: number,
  failed: number,
}
```

## Implementation Notes

- **Snapshot targets at start** — use `connectedTerminals` minus self at invocation time. Joins/leaves during execution don't change the wait set.
- **Handle "no other terminals"** — return an empty success result immediately.
- **Deterministic ordering** — sort target names so summaries and details are stable.
- **Busy terminals** — each receiver only accepts one remote prompt at a time, so some may reply "Terminal is busy". This fits the partial-failure model.

### Accumulator pattern

Reuse `pendingPromptResponses` with per-target closure resolvers. Each target gets its own `requestId` and entry in the map, but the resolve callback writes into a shared accumulator object + decrements a `remaining` counter. When `remaining` hits 0, resolve the outer tool promise. No separate map or `handleIncoming` branch needed.

### Double-count prevention for failed targets

When `routeMessage()` returns `false` on the hub, it also synthesizes a `prompt_response` error via `handleIncoming`. To avoid double-counting:

- If `routeMessage()` returns `false`, do NOT register a `pendingPromptResponses` entry for that target
- Mark it failed in the accumulator immediately and decrement `remaining`
- This ensures the synthesized error has no pending entry to hit

### Cleanup on completion / abort / disconnect

When the outer promise resolves (all targets done, or abort), must:

1. Clear all outstanding `setTimeout` handles
2. Delete all outstanding entries from `pendingPromptResponses`
3. Late `prompt_response`s arriving after resolution find no pending entry — harmlessly ignored

Same cleanup applies to abort signal and disconnect events.

### renderResult truncation

For large target counts:

- Truncate per-response previews (reuse `truncatePreview()`)
- Cap visible rows at a reasonable limit (e.g., 10) with a `+ N more` summary

---

## Batch 1 — Core tool registration & fan-out

Register the tool and send prompts to all targets.

### Steps

1. Register `link_broadcast_prompt` tool:
   - Parameters: `prompt: string`
   - Description explains fan-out and partial failure semantics
2. On execute:
   - Early return with `notConnectedResult()` if disconnected
   - Snapshot targets: `connectedTerminals.filter(n => n !== terminalName).sort()`
   - Early return if no targets: `textResult("No other terminals connected", { responses: {}, total: 0, ok: 0, failed: 0 })`
3. Generate one `requestId` per target using `crypto.randomUUID()`
4. For each target, call `routeMessage()`:
   - If returns `false`: mark target as `{ status: "error", error: "not_delivered" }` in accumulator, decrement `remaining`. Do NOT register in `pendingPromptResponses`.
   - If returns `true`: register in `pendingPromptResponses` with a closure resolver (see Batch 2).
5. If all targets failed immediately (`remaining === 0`), resolve the tool promise right away.

### Output

Tool is registered, prompts fan out, but responses aren't collected yet — tool resolves immediately with a placeholder. This lets us verify the fan-out works before wiring up collection.

---

## Batch 2 — Collection & resolution

Wire up response collection so the tool waits for all targets to respond.

### Steps

1. Create a `Promise` that resolves when all targets have a result (ok, error, or timeout)
2. Shared state:
   - `results: Record<string, { status, response?, error? }>` — accumulator, pre-populated with immediate failures from Batch 1
   - `remaining: number` — count of targets still pending
   - `timeouts: Map<string, NodeJS.Timeout>` — per-target timeout handles
   - `resolved: boolean` — guard against late settlement
3. For each successfully-routed target:
   - Start a per-target `setTimeout(PROMPT_TIMEOUT_MS)`
   - On timeout: write `{ status: "timeout" }` to accumulator, delete pending entry, decrement remaining, check if done
   - Register in `pendingPromptResponses` with a closure that:
     - Writes `{ status: "ok", response }` or `{ status: "error", error }` to accumulator
     - Clears the target's timeout
     - Decrements `remaining`, checks if done
4. "Check if done" means: if `remaining === 0` and not yet `resolved`:
   - Set `resolved = true`
   - Clear all outstanding timeouts
   - Delete all outstanding `pendingPromptResponses` entries
   - Resolve the outer promise with final results
5. Abort signal support:
   - On abort: set `resolved = true`, clear all timeouts, delete all pending entries
   - Mark all remaining targets as `{ status: "error", error: "aborted" }`
   - Resolve immediately with partial results

### Output

Tool fully works end-to-end: fans out, collects, handles timeouts and errors, resolves with the complete results map.

---

## Batch 3 — Result formatting & rendering

Polish the output for both LLM and human consumption.

### Steps

1. Format `content` summary: `"Collected N/M responses (X ok, Y failed)"`
2. Format `details` with the full structured map plus `total`, `ok`, `failed` counts
3. Add `renderCall`:
   - Show "link_broadcast_prompt" title
   - Preview prompt text using `truncatePreview()`
   - Show target count: e.g., "→ 4 terminals"
4. Add `renderResult`:
   - Summary line with ok/failed counts
   - Per-terminal status lines with ✓/✗ icons and response previews
   - Truncate per-response previews via `truncatePreview()`
   - Cap at 10 visible rows, show `+ N more` if exceeded

### Output

Complete feature: functional, well-formatted, easy for both LLMs and humans to interpret.
