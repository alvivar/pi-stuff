# Plan: Automatic Agent Status

Show what each terminal is doing in `link_list` and `/link`. Status is derived from Pi lifecycle events — agents can't set it manually.

## States

```
idle                 — waiting for user input
thinking             — LLM is generating
tool:<toolName>      — running a specific tool (bash, edit, read, link_prompt, etc.)
```

## Local Truth

Two booleans + one string drive everything:

```typescript
let agentRunning = false;
let activeToolName: string | null = null;
```

One function derives the visible status:

```typescript
function deriveStatus(): LinkStatus {
  if (activeToolName)
    return { kind: "tool", toolName: activeToolName, since: toolSince };
  if (agentRunning) return { kind: "thinking", since: thinkingSince };
  return { kind: "idle", since: idleSince };
}
```

Precedence: tool > thinking > idle. Events mutate `agentRunning` and `activeToolName`, never the status directly.

## Events → Local State

```
agent_start          → agentRunning = true, thinkingSince = now
tool_execution_start → activeToolName = toolName, toolSince = now
tool_execution_end   → activeToolName = null, thinkingSince = now (if agentRunning)
agent_end            → agentRunning = false, activeToolName = null, idleSince = now
```

After each mutation, call `pushStatus()`.

## Status Shape

```typescript
type LinkStatus =
  | { kind: "idle"; since: number }
  | { kind: "thinking"; since: number }
  | { kind: "tool"; toolName: string; since: number };
```

`since` is `Date.now()`. Durations are computed at render time, not pushed.

## Push Logic

```typescript
let lastPushedKind: string | null = null;
let lastPushedTool: string | null = null;

function pushStatus(force = false) {
  if (role === "disconnected") return;
  const status = deriveStatus();
  const newKind = status.kind;
  const newTool = status.kind === "tool" ? status.toolName : null;
  if (!force && newKind === lastPushedKind && newTool === lastPushedTool)
    return;
  lastPushedKind = newKind;
  lastPushedTool = newTool;
  send({ type: "status_update", name: terminalName, status });
}
```

**Force push** (`pushStatus(true)`) on:

- After receiving `welcome` (new connection/reconnection)
- After rename (name changed, others need the new key)

**Reset push state** (`lastPushedKind = null`) on:

- `disconnect()` — so next connect always pushes

This covers: reconnect after hub loss, hub promotion, client rename (which reconnects), hub rename (in-place, force push).

## Protocol

One new message type added to `LinkMessage` union:

```typescript
{
  type: "status_update";
  name: string;
  status: LinkStatus;
}
```

### Hub handling of `status_update`

`status_update` uses a direct send path, not `routeMessage()` — it's not a targeted routable message, it's a hub-stored protocol message with fan-out.

- Store in `terminalStatuses: Map<string, LinkStatus>` (other terminals only, not self)
- Broadcast to all other terminals

### Client handling of `status_update`

- Store in local `terminalStatuses: Map<string, LinkStatus>`

### Welcome sync

Extend `welcome` payload with `statuses: Record<string, LinkStatus>`.

Hub builds the snapshot by:

1. Start with all entries from `terminalStatuses` (remote clients)
2. Add hub's own status: `myStatus` derived from `deriveStatus()`
3. Exclude the joining terminal's own name

Client on receiving welcome:

1. Populate `terminalStatuses` from `statuses` field
2. Call `pushStatus(true)` to announce own status to everyone

### Hub rename

Hub rename is in-place (no reconnect). On hub rename:

1. Delete old name from `terminalStatuses` (if present — shouldn't be since hub stores self separately)
2. Call `pushStatus(true)` to broadcast status under new name
3. Others already get `terminal_left` + `terminal_joined` which updates their terminal list — the forced status push updates the status key

### Client rename

Client rename triggers reconnect. The reconnect path already:

1. Resets `lastPushedKind` in `disconnect()`
2. Gets fresh `welcome` with statuses
3. Calls `pushStatus(true)` after welcome

No special handling needed.

## Cleanup

**On `leave` message (terminal disconnected):**

- Delete from `terminalStatuses` (both hub and client side)

**On `disconnect()`:**

- Clear `terminalStatuses` map
- Reset `lastPushedKind = null`, `lastPushedTool = null`

**On `session_shutdown`:**

- Cleanup already calls `disconnect()`

## State Ownership Summary

- `myStatus`: derived from `agentRunning` + `activeToolName` via `deriveStatus()` — never stored, always computed
- `terminalStatuses`: stores **other terminals only**
- When rendering (link_list, /link, welcome snapshot): merge `deriveStatus()` for self with `terminalStatuses` for others

---

## Batches

### Batch 1: Local state tracking + protocol

1. Add `agentRunning`, `activeToolName`, `thinkingSince`, `toolSince`, `idleSince` state variables
2. Add `lastPushedKind`, `lastPushedTool` for change detection
3. Add `terminalStatuses: Map<string, LinkStatus>` for remote statuses
4. Add `LinkStatus` type and `status_update` to `LinkMessage` union
5. Implement `deriveStatus()` and `pushStatus(force?)`
6. Add 4 event hooks: `agent_start`, `agent_end`, `tool_execution_start`, `tool_execution_end`
7. Hub: handle `status_update` — store and broadcast
8. Client: handle `status_update` — store in local map
9. Reset push state in `disconnect()`
10. Delete from `terminalStatuses` on `leave`

### Batch 2: Welcome sync + rename

1. Extend `welcome` with `statuses` field
2. Hub: build snapshot from `terminalStatuses` + own `deriveStatus()`
3. Client: populate `terminalStatuses` from welcome
4. Call `pushStatus(true)` after welcome processing
5. Hub rename: force push status under new name
6. Client rename: covered by reconnect path (disconnect resets, welcome syncs, force push announces)
7. Clear `terminalStatuses` in `disconnect()`

### Batch 3: Render

1. `formatDuration(since)`: seconds → `3s` / `2m` / `1h`
2. `formatStatus(status)`: `idle (2m)` / `thinking (3s)` / `tool:bash (12s)`
3. `link_list` tool: include status in response content and renderResult
4. `/link` command: show status next to each name
