# Monitor Mode

## Goal

Let a terminal opt in to receiving copies of all direct chat/prompt traffic between other terminals. The monitor is a normal participant — can send, receive, be targeted, execute prompts. Its behavior is defined by its system prompt/rules, not by protocol restrictions.

Use cases: supervision, coordination oversight, live debugging, progress summarization.

**Not**: passive observer, audit log, or guaranteed delivery.

## Concept

Monitor mode adds one capability: **traffic copies**. Everything else is normal pi-link behavior.

- `--link-monitor` flag opts in at startup
- Hub fans out `traffic_copy` messages after routing direct traffic
- Copies go through the existing idle-gated inbox → batched `triggerTurn:true` delivery
- The agent's prompt/rules decide what to do (summarize, alert, intervene, stay quiet)

## Protocol

New message type:

```ts
interface TrafficCopyMsg {
  type: "traffic_copy";
  originalType: "chat" | "prompt_request" | "prompt_response";
  from: string;
  to: string;
  content: string;  // body text, truncated at TRAFFIC_COPY_MAX_CHARS
  id?: string;      // prompt request/response correlation
}
```

Why a dedicated type: raw chat/prompt messages have behavior attached in `handleIncoming` (execute prompts, touch pending state, push to inbox as direct messages). A distinct type keeps copies inert until explicitly handled.

Additive protocol fields:

```ts
RegisterMsg.monitor?: boolean
WelcomeMsg.monitors?: string[]
TerminalJoinedMsg.monitor?: boolean
```

## State

```ts
let monitorMode = false;                       // set from --link-monitor in session_start
const monitorNames = new Set<string>();         // all terminals: render [monitoring] tags
const monitorClients = new Set<WebSocket>();    // hub only: monitor sockets
```

`monitorNames` maintained by both hub and clients:
- Hub: from register/close events and local `monitorMode`
- Clients: from `WelcomeMsg.monitors`, `TerminalJoinedMsg.monitor`, `terminal_left`

## Hub: traffic copy fanout

After successfully routing a **direct** message (not broadcast), fan out copies.

Content extraction:

```ts
function extractTrafficContent(msg: ChatMsg | PromptRequestMsg | PromptResponseMsg): string {
  if (msg.type === "chat") return msg.content;
  if (msg.type === "prompt_request") return msg.prompt;
  return msg.error ? `ERROR: ${msg.error}` : msg.response;
}
```

Fanout:

```ts
function fanoutTrafficCopy(msg: ChatMsg | PromptRequestMsg | PromptResponseMsg) {
  if (msg.to === "*") return;  // broadcasts already reach everyone
  if (monitorClients.size === 0 && !monitorMode) return;  // fast path

  const text = extractTrafficContent(msg);
  const copy: TrafficCopyMsg = {
    type: "traffic_copy",
    originalType: msg.type,
    from: msg.from,
    to: msg.to,
    content: text.length > TRAFFIC_COPY_MAX_CHARS
      ? text.slice(0, TRAFFIC_COPY_MAX_CHARS) + "… [truncated]"
      : text,
    id: "id" in msg ? msg.id : undefined,
  };
  const json = JSON.stringify(copy);

  // Fan out to monitor clients, excluding sender and target (they already have it)
  for (const ws of monitorClients) {
    const name = hubClients.get(ws);
    if (!name || name === msg.from || name === msg.to) continue;
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(json); } catch {}
    }
  }

  // Hub-as-monitor: observe locally if hub is not sender or target
  if (monitorMode && terminalName !== msg.from && terminalName !== msg.to) {
    handleIncoming(copy);
  }
}
```

Called in `routeMessage` after each successful direct delivery:
- `to: hub` → `handleIncoming(msg)` then `fanoutTrafficCopy(msg)`
- `to: client` → `targetWs.send(json)` then `fanoutTrafficCopy(msg)`
- `to: "*"` → `hubBroadcast(msg, msg.from)` only. No fanout — monitors already get broadcasts.
- Target not found → no fanout (message wasn't delivered)

## Client: handling traffic copies

```ts
case "traffic_copy": {
  const id = msg.id ? ` #${msg.id.slice(0, 8)}` : "";
  inbox.push({
    from: `[${msg.originalType}${id}] ${msg.from} → ${msg.to}`,
    content: msg.content,
  });
  scheduleFlush(FLUSH_DELAY_MS);
  break;
}
```

Reuses existing inbox. Copies batch with other inbox items and deliver as `[Link: N message(s) received]` when idle. Prompt IDs (truncated to 8 chars) help the agent correlate requests with responses.

## Truncation

`TRAFFIC_COPY_MAX_CHARS = 4_000`. Applied hub-side before sending. Prevents one large prompt response from dominating. Intentionally separate from `BATCH_MAX_CHARS` (16K) — they solve different problems.

## Flag

```ts
pi.registerFlag("link-monitor", {
  description: "Receive copies of all direct link traffic. Implies --link.",
  type: "boolean",
  default: false,
});
```

In `session_start`: set `monitorMode = pi.getFlag("link-monitor") === true` before `shouldConnect`.
In `shouldConnect`: if `monitorMode`, return `true` immediately — overrides saved `/link-disconnect`. Explicit startup flag wins.
In `connectAsClient` register: `monitor: monitorMode || undefined`.

Not persisted. Startup-only. User passes `--link-monitor` each time.

## Hub registration

On register with `monitor: true`:
- Add ws to `monitorClients`
- Include in `WelcomeMsg.monitors`
- Set `monitor: true` on `TerminalJoinedMsg`

On close:
- Remove from `monitorClients`

## UI

`link_list` and `/link`: append `[monitoring]` tag to terminals in `monitorNames`.

No special message renderer needed — traffic copies go through the existing inbox batch renderer (`[Link: N message(s) received]`). The `from` field shows the original routing info (e.g., `[chat] builder → reviewer`).

## What monitor mode does NOT change

Tools, commands, prompts, status, membership — all normal.

## Rename handling

`/link-name` hub rename broadcasts `terminal_left` + `terminal_joined`. The synthetic `terminal_joined` must carry `monitor: true` if the renamed terminal is a monitor. Hub local rename: update `monitorNames` (delete old, add new if still monitoring). Client monitors reconnect on rename — registration re-adds them to `monitorClients`.

## Cleanup

`disconnect()`: add `monitorClients.clear()`, `monitorNames.clear()`.

## Cost caveat

Active monitoring means traffic copies trigger LLM turns on the monitor via inbox batching. A busy link increases model usage on the monitor terminal. The existing batch caps (`BATCH_MAX_ITEMS=20`, `BATCH_MAX_CHARS=16_000`) limit per-turn volume, and idle-gating coalesces bursts.

## Loop risk

A monitor that intervenes creates new traffic, which other monitors would see. This is acceptable with one monitor. Multiple monitors watching each other could amplify traffic. Mitigation: monitors are visible via `[monitoring]` tag; agents can be instructed to ignore monitor-originated traffic if needed.

## Single batch

The feature is small because it reuses existing infrastructure:
- Inbox + idle-gated batching (existing)
- Hub routing structure (existing, add fanout calls)
- Protocol is additive (3 optional fields + 1 new message type)
- No new tools, no new commands, no behavior restrictions
