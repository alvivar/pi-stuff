# PLAN — `link_compact` (await-completion)

## Goal

One new tool, `link_compact(to, instructions?)`, that asks another terminal to compact its
context window **and blocks until that compaction finishes**, then returns. Modeled on
`link_prompt` (request/response with a pending map + timeout), not `link_send`.

## Use case & division of labor

An orchestrator watches worker context usage in `link_list` (shipped) and compacts a worker
when it gets too loaded. Because the call only returns once compaction is **done**, the
orchestrator can in the very next step hand the freshly-trimmed worker more work
(`link_send` / `link_prompt`) — no `sleep`, no polling, no busy-bounce.

- **pi-link provides the _action + completion signal_** (`link_compact`).
- **The orchestrator LLM owns the _policy_** (the "keep it under N tokens" threshold, when to
  compact, what to dispatch next). No threshold config or auto-compact daemon in pi-link.

## Why await-completion (the design we reversed into)

Fire-and-forget was the original plan. It fails the real workflow: the orchestrator wants to
compact **then immediately deliver work**. With fire-and-forget it would have to `sleep`/poll
`link_list` guessing when compaction ended, and a `link_prompt` sent during the ~5–60s
compaction bounces (target is busy). So `link_compact` must report completion. Pi's
`ctx.compact({ onComplete, onError })` gives us exactly that signal.

## Non-goals (still cut)

- Consent / `/link-control` gate, default-deny — **none**. Compact like any other link tool.
- Capability advertisement (`remoteControl` flag), `terminalCapabilities` maps — **none**.
- Cooldown, audit session entry — **none**.
- `set_model` / `set_thinking`, generic `control_request` union — **none**.
- Broadcast (`to: "*"`) compact — **disallowed**; single named target only.
- Receiver-side queue/defer of a busy compact — **none**; busy declines, orchestrator retries.

## Design

### 1. Wire messages (request carries an `id`; one response type)

```ts
interface CompactRequestMsg {
  type: "compact_request";
  id: string; // correlates the response
  from: string;
  to: string;
  instructions?: string;
}
interface CompactResponseMsg {
  type: "compact_response";
  id: string;
  from: string; // the terminal that compacted (or the hub, for not_found)
  to: string;
  ok: boolean;
  reason?: string; // "busy" | "not_found" | "unsupported" | error text; absent on success
}
```

Both added to the `LinkMessage` union.

### 2. Hub routing — authoritative `from`, plus a `not_found` response

`compact_request` **and** `compact_response` are added to the normalize-and-forward list, so
the hub rewrites `from` and relays both directions. The hub's not-found branch, which already
synthesizes a `prompt_response` error for `prompt_request`, now also synthesizes a
`compact_response { ok:false, reason:"not_found" }` (delivered locally if the sender is the hub,
else sent to the sender). This stops a racing/stale target from hanging the caller to timeout.

### 3. Receiver handler — busy-decline, else compact and report completion

```ts
case "compact_request": {
  if (agentRunning || pendingRemotePrompt || compactRunning) {
    routeMessage({ type: "compact_response", id: msg.id, from: terminalName,
                   to: msg.from, ok: false, reason: "busy" });
    break;
  }
  const { id, from } = msg;
  let finished = false;
  const finish = (ok, reason?) => {
    if (finished) return;
    finished = true;
    compactRunning = false;
    routeMessage({ type: "compact_response", id, from: terminalName, to: from, ok, reason });
  };
  if (!ctx?.compact) { finish(false, "unsupported"); break; }
  compactRunning = true;
  notify(`"${from}" requested compact`, "info");
  try {
    ctx.compact({
      customInstructions: msg.instructions,
      onComplete: () => finish(true),
      onError: (e) => finish(false, e instanceof Error ? e.message : String(e)),
    });
  } catch (e) { finish(false, e instanceof Error ? e.message : String(e)); }
  break;
}
```

- **Busy guard** = `agentRunning || pendingRemotePrompt || compactRunning`. `compact()` calls
  `await this.abort()` first (verified in agent-session.js), so without this guard a compact would
  **abort the target's in-flight turn**. The new `compactRunning` flag also blocks a second concurrent
  compact, and is added to the `prompt_request` busy check so a prompt can't land mid-compaction.
- **`finish()` is idempotent** (`finished` flag) so sync-throw / `onError` / `onComplete` / disconnect
  can't double-resolve, and always clears `compactRunning`.
- **No receiver-side timeout needed**: the runtime wrapper guarantees exactly one of
  `onComplete`/`onError` fires (it `await`s `session.compact` inside try/catch — see
  interactive-mode.js), so `compactRunning` can't get stuck.

### 4. Sender — pending map + flat timeout (mirrors `link_prompt`)

A dedicated `pendingCompactResponses` map (separate from `pendingPromptResponses`: different result
shape, flat timeout vs. inactivity/ceiling semantics) with a `cleanupPendingCompact` helper. The
tool returns a `Promise` that resolves when the matching `compact_response` arrives, on a flat
**180s** timeout, on abort (`signal`), or on `not_delivered`. The `compact_response` receiver case
resolves the pending entry: `ok` → `Compacted "<from>"`; else `Compact on "<from>" not done: <reason>`.

Pending compacts are also failed on `terminal_left` (target departed) and on link disconnect,
exactly like pending prompts.

### 5. Tool result vocabulary

`compacted` (success) / `busy` / `not_found` / `unsupported` / `timeout` / `aborted` /
`not_delivered` / error text. Orchestrator reads `details.error` (absent on success).

## Constants

```ts
const COMPACT_TIMEOUT_MS = 180_000; // headroom for large-context / slow-provider compaction
```

## Pi API references (verified)

```ts
// dist/core/extensions/types.d.ts
interface CompactOptions {
  customInstructions?;
  onComplete?: (r) => void;
  onError?: (e: Error) => void;
}
interface ExtensionContext {
  compact(options?: CompactOptions): void;
}
// agent-session.js compact():  this._disconnectFromAgent(); await this.abort(); ...  (aborts turn)
// interactive-mode.js ctx.compact wrapper: await session.compact(); onComplete | catch->onError
```

## Implementation order (done)

1. `COMPACT_TIMEOUT_MS` constant.
2. `CompactRequestMsg` (+`id`) and `CompactResponseMsg` types + union entries.
3. `compactRunning` flag; `pendingCompactResponses` map; `cleanupPendingCompact`.
4. `routeMessage` param widened; hub not-found `compact_response`; normalize-and-forward entries.
5. Receiver `case "compact_request"` (busy-decline + finish) and `case "compact_response"`.
6. `prompt_request` busy check includes `compactRunning`; `terminal_left` + disconnect cleanup.
7. `link_compact` tool: await-completion execute + updated description.
8. SKILL.md line updated to the blocking/await contract.
9. esbuild bundle check (clean, 45.3kb).
10. Live test (below), then delegate README rewrite to docs.

## Test plan

- **Happy path → immediate dispatch**: give a test terminal real context; `link_compact` it and
  confirm the tool **blocks then returns `Compacted "<x>"`**; immediately `link_prompt` the same
  terminal and confirm **no busy-bounce** (it's idle post-compaction). Watch `link_list` drop too.
- **busy**: while a terminal is mid-turn, `link_compact` it → returns `busy` promptly (its work
  is NOT aborted).
- **not_found**: typo'd name → tool-level not_found (connected list); racing stale target → hub
  `compact_response{not_found}`.
- **self**: own name → self hint, no wire traffic.
- **timeout**: (hard to force live) — covered by the flat 180s + pending cleanup paths.
- **instructions**: pass custom instructions; best-effort visual check they reach `ctx.compact`.
