# Observer Mode

## Goal

Let a terminal see copies of all routed chat/prompt traffic without participating.
Use case: live supervision, debugging, monitoring.

**Not**: durable audit logging, recording, or guaranteed delivery.

## Design

Observer = read-only. Cannot send, cannot be targeted, cannot execute prompts.
Startup-only via `--link-observe` flag. Not persisted, not toggleable mid-session.
Observers are visible in terminal list with `[observing]` tag.

## Protocol changes (additive optional fields)

```ts
RegisterMsg.observer?: boolean
WelcomeMsg.observers?: string[]
TerminalJoinedMsg.observer?: boolean
```

## State

```ts
let observerMode = false; // set from --link-observe in session_start
const observerNames = new Set<string>(); // all terminals: render [observing] tags
const observerClients = new Set<WebSocket>(); // hub only: observer sockets
```

`observerNames` is maintained by both hub and clients:

- Hub: from register/close events and local `observerMode`
- Clients: from `WelcomeMsg.observers`, `TerminalJoinedMsg.observer`, `terminal_left`

## Rules

### Hub routing (`routeMessage`)

Checked in order:

1. **Sender is observer** → reject/ignore (hub-side enforcement, not just client-side tool blocking)
2. **`msg.to !== "*"` and target is observer** → reject with error (prompt_response error for prompts, error msg for chat). This includes hub-as-observer.
3. **`to: "*"`** → `hubBroadcast(msg, msg.from)` only. No extra observer fanout — observers are regular hubClients, already receive broadcast.
4. **`to: hub`** → `handleIncoming(msg)` then `fanoutToObserverClients(msg)`
5. **`to: client`** → send to target + `fanoutToObserverClients(msg)` + if hub is observer and hub is not sender, `observeMessage(msg)`

### Client-side (`handleIncoming`)

Observer-first guard: if `observerMode` and message is chat/prompt_request/prompt_response → `observeMessage(msg)`, return.

Catches ALL chat/prompt traffic including broadcasts (`to: "*"`). Prevents observer from triggering LLM turns, executing prompts, or touching pending prompt map.

Does NOT intercept: welcome, terminal_joined, terminal_left, status_update, error — these are membership/meta, not traffic.

### Tool/command blocking when `observerMode`

- `link_send` → "Observer mode: cannot send messages"
- `link_prompt` → "Observer mode: cannot send prompts"
- `/link-broadcast` → "Observer mode: cannot broadcast"

### Hub helpers

```ts
function isObserverName(name: string): boolean {
  if (name === terminalName) return observerMode;
  const ws = hubClientByName(name);
  return !!ws && observerClients.has(ws);
}

function fanoutToObserverClients(msg) {
  // Send copy to all observer clients except msg.from (by name, not ws identity)
  const json = JSON.stringify(msg);
  for (const obs of observerClients) {
    const name = hubClients.get(obs);
    if (name && name !== msg.from && obs.readyState === WebSocket.OPEN) {
      try {
        obs.send(json);
      } catch {}
    }
  }
}
```

## Observed message delivery

```ts
const OBSERVED_MAX_CHARS = 8_000;
```

`observeMessage(msg)`: injects a displayed `link-observed` custom message. No `deliverAs` — accumulates in session, visible on observer's next turn.

```ts
function observeMessage(msg: ChatMsg | PromptRequestMsg | PromptResponseMsg) {
  if (!isRuntimeLive()) return;
  pi.sendMessage(
    {
      customType: "link-observed",
      content: formatObservedContent(msg), // type-specific, truncated at OBSERVED_MAX_CHARS
      display: true,
      details: { observed: true, type: msg.type, from: msg.from, to: msg.to },
    },
    { triggerTurn: false },
  );
}
```

No notify per message — displayed custom message is sufficient. Avoids noise on busy links.

## Hub registration

On register with `observer: true`:

- Add ws to `observerClients`
- Include client name in `WelcomeMsg.observers` (includes self if registering as observer)
- Set `observer: true` on `TerminalJoinedMsg`

On close:

- Remove from `observerClients`

## Flag

```ts
pi.registerFlag("link-observe", {
  description:
    "Connect as observer (see all traffic, read-only). Implies --link.",
  type: "boolean",
  default: false,
});
```

In `session_start`: set `observerMode = pi.getFlag("link-observe") === true` before `shouldConnect()`.
In `shouldConnect()`: `|| pi.getFlag("link-observe") === true`.
In `connectAsClient` register msg: `observer: observerMode || undefined`.

## Hub-as-observer

Hub sets `observerMode` from `--link-observe` flag like any terminal.

- Direct messages to hub observer are **rejected** by rule #2 (target is observer → error). Hub never receives them via `handleIncoming`.
- Broadcast copies reach hub observer through `hubBroadcast → handleIncoming` → observer-first guard → `observeMessage`.
- Client-to-client direct messages: hub routes them in `routeMessage` rule #5. If `observerMode && msg.from !== terminalName`, call `observeMessage(msg)` locally.

## UI

`link_list` and `/link`: append `[observing]` tag to terminals in `observerNames`.
Message renderer for `link-observed`: dim styling with `[observed]` prefix.

## Cleanup

`disconnect()`: add `observerClients.clear()`, `observerNames.clear()`.

## Single batch

All pieces are coupled — observer existence without rejection creates broken states, observer routing without UI tags creates invisible wiretaps. Ship as one complete vertical slice.
