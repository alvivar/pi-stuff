# PLAN — Context usage in `link_list` and `/link` (0.1.15)

## Goal

Each connected terminal broadcasts its current LLM context usage (`tokens`, `contextWindow`) over the link. Other terminals see it inline in `/link` output and as structured data in the `link_list` tool result.

Display target (chosen from earlier discussion):

```
opus@pi-link: idle (2m) · 45K/200K (23%)
  cwd: ~/.pi
```

This is the foundation for orchestrator patterns: an orchestrator terminal can see "worker is at 80% context" before deciding to ask for compaction. Compaction-as-action is **out of scope** for this release — it ships in a separate plan (`PLAN-orchestration.md`).

## Non-goals

- Remote `compact` / `setModel` / `setThinkingLevel` actions — separate release
- Per-terminal model and thinking-level broadcast — separate release (orchestration)
- UI alerts/colors when context approaches limit — defer to v2
- Push-on-every-token-tick during streaming — push timing matches existing status events

## Pi API references

From `dist/core/extensions/types.d.ts`:

```ts
interface ContextUsage {
  tokens: number | null; // null right after compaction, before next LLM response
  contextWindow: number;
  percent: number | null; // null when tokens null
}

interface ExtensionContext {
  getContextUsage(): ContextUsage | undefined;
  // ... other fields
}
```

Three states to handle:

1. `getContextUsage()` returns `undefined` (or `contextWindow <= 0`) — no model, or pre-init. Send `context: null` so peers **clear** any previously-stored value. (Omitting the field would leave a stale snapshot on peers forever — see context-clearing below.)
2. Returns object with `tokens: null` — post-compaction or pre-first-turn. Send `{ tokens: null, contextWindow: N }`. Note `tokens: null` is **valid data**, not "missing": display falls back to `?/200K`. Only a whole-snapshot `null` means clear.
3. Returns full object — send `{ tokens, contextWindow }`. `percent` derived at display time.

Relevant Pi events for triggering re-push:

- `agent_start` — push (existing)
- `agent_end` — push (existing); tokens just changed, important
- `tool_execution_start` / `tool_execution_end` — push (existing)
- **NEW**: `session_compact` — push (force=true); tokens dropped sharply, downstream needs to know

## Wire format changes

### `LinkStatus` — extend with optional context

Today:

```ts
type LinkStatus =
  | { kind: "idle"; since: number }
  | { kind: "thinking"; since: number }
  | { kind: "tool"; toolName: string; since: number };
```

Change: add a sibling field on the _status payload_ (not inside the kind-discriminator). `LinkStatus` describes activity kind + duration; context is orthogonal. Two options:

**Option A — flat extension on `StatusUpdateMsg`** (preferred):

```ts
interface StatusUpdateMsg {
  type: "status_update";
  name: string;
  status: LinkStatus;
  context?: ContextSnapshot | null; // null = "I no longer have context" (clear stored value); absent = old terminal
}
type ContextSnapshot = { tokens: number | null; contextWindow: number };
```

**Option B — embed in `LinkStatus`**: would require widening every kind variant. Worse: `LinkStatus` is also returned by `deriveStatus()` and used internally by display helpers; we'd touch more code.

**Decision: Option A** — orthogonal field on the message. `LinkStatus` stays focused on activity.

### Register / Welcome / TerminalJoined — initial snapshot

These carry `cwd` today as the per-terminal snapshot at join time. Add `context` the same way. They stay `context?: ContextSnapshot` (no `| null`): these are join-time snapshots, so a terminal either has context (object) or doesn't yet (omit) — there is nothing to clear at join. The `null`-clear semantic is **only** a `status_update` concern.

```ts
interface RegisterMsg {
  type: "register";
  name: string;
  cwd?: string;
  context?: ContextSnapshot; // NEW
}

interface WelcomeMsg {
  type: "welcome";
  name: string;
  terminals: string[];
  statuses?: Record<string, LinkStatus>;
  cwds?: Record<string, string>;
  contexts?: Record<string, ContextSnapshot>; // NEW
}

interface TerminalJoinedMsg {
  type: "terminal_joined";
  name: string;
  terminals: string[];
  cwd?: string;
  context?: ContextSnapshot; // NEW
}
```

### Capabilities field — deferred

Earlier draft pre-baked `capabilities: { remoteControl: false }` for forward-compat. Per GPT's second pass: drop it. A future orchestrator treats absent `capabilities` and `{ remoteControl: false }` identically (both mean "doesn't support remote control"), so pre-baking saves zero migration work. Add the field with orchestration.

## Implementation outline (`index.ts`)

### 1. State additions

```ts
let lastPushedContext: ContextSnapshot | null = null;
const hubTerminalContexts = new Map<string, ContextSnapshot>(); // hub-authoritative
const terminalContexts = new Map<string, ContextSnapshot>(); // client view
```

### 2. Helper: capture current usage

```ts
function captureContext(): ContextSnapshot | undefined {
  if (!ctx) return undefined;
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;
  if (usage.contextWindow <= 0) return undefined; // 0/negative window = no real context to report
  return { tokens: usage.tokens, contextWindow: usage.contextWindow };
}
```

### 3. Modify `pushStatus`

The dedup currently suppresses pushes when `(kind, toolName)` is unchanged. Extend the comparison to also consider context. Force-push when context changes even if status didn't.

```ts
function pushStatus(force = false) {
  if (role === "disconnected") return;
  const status = deriveStatus();
  const context = captureContext();
  const newKind = status.kind;
  const newTool = status.kind === "tool" ? status.toolName : null;
  if (
    !force &&
    newKind === lastPushedKind &&
    newTool === lastPushedTool &&
    sameContext(context, lastPushedContext)
  ) {
    return;
  }
  lastPushedKind = newKind;
  lastPushedTool = newTool;
  lastPushedContext = context ?? null;
  const msg: StatusUpdateMsg = {
    type: "status_update",
    name: terminalName,
    status,
    context: context ?? null, // explicit null tells peers to clear; never omit from a live terminal
  };
  // ... existing send logic
}

function sameContext(
  a: ContextSnapshot | undefined,
  b: ContextSnapshot | null,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.tokens === b.tokens && a.contextWindow === b.contextWindow;
}
```

### 4. Hook `session_compact` event

```ts
pi.on("session_compact", async () => {
  pushStatus(true); // force, because tokens just dropped
});
```

Place near the other `pi.on(...)` calls around line 1006–1033.

### 5. Hub: store and forward context

In `hubHandleClient`, when a status_update arrives, also persist `msg.context` and include it in the normalized broadcast:

```ts
if (msg.type === "status_update") {
  hubTerminalStatuses.set(clientName, msg.status);
  // Truthy object stores; explicit null clears; absent (old client) leaves as-is.
  if (msg.context) {
    hubTerminalContexts.set(clientName, msg.context);
  } else if (msg.context === null) {
    hubTerminalContexts.delete(clientName);
  }
  resetInactivityFor(clientName);
  const normalized: StatusUpdateMsg = {
    type: "status_update",
    name: clientName,
    status: msg.status,
    ...(msg.context !== undefined ? { context: msg.context } : {}), // forward null through so downstream clears too
  };
  // ... existing fan-out
}
```

When a client registers, capture their initial context and send back snapshots in the welcome.

On client disconnect/close, delete the entry: `hubTerminalContexts.delete(clientName)` — mirror the existing `hubTerminalStatuses.delete(clientName)` cleanup. Without it, a same-named terminal reconnecting later (or another consumer) could read stale context from the departed terminal.

### 6. Client: store incoming context

In the existing `status_update` handler:

```ts
case "status_update":
  terminalStatuses.set(msg.name, msg.status);
  if (msg.context) {
    terminalContexts.set(msg.name, msg.context);
  } else if (msg.context === null) {
    terminalContexts.delete(msg.name);
  }
  resetInactivityFor(msg.name);
  break;
```

Welcome/terminal_joined handlers absorb `contexts`/`context` similarly. The `terminal_left` handler deletes the entry: `terminalContexts.delete(msg.name)`, alongside the existing `terminalStatuses.delete(msg.name)`.

### 7. Display

New helper:

```ts
function formatContext(c: ContextSnapshot | null | undefined): string {
  if (!c) return "";
  const window = formatTokens(c.contextWindow);
  if (c.tokens === null) return `?/${window}`;
  const tokens = formatTokens(c.tokens);
  const percent = Math.round((c.tokens / c.contextWindow) * 100);
  return `${tokens}/${window} (${percent}%)`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}
```

`getContextFor(name)` mirrors `getStatusFor` / `getCwdFor`:

```ts
function getContextFor(name: string): ContextSnapshot | null {
  if (name === terminalName) return captureContext() ?? null;
  const map = role === "hub" ? hubTerminalContexts : terminalContexts;
  return map.get(name) ?? null;
}
```

`/link` formatter (around line 1370+) — current line:

```
${name}${marker}${statusStr ? ": " + statusStr : ""}
```

Becomes:

```ts
const ctxStr = formatContext(getContextFor(name));
let line = `${name}${marker}${statusStr ? ": " + statusStr : ""}`;
if (ctxStr) line += ` · ${ctxStr}`;
if (cwd) line += `\n  cwd: ${shortenPath(cwd)}`;
```

`link_list` tool (around line 1295+) — current details object:

```ts
{
  (terminals, statuses, cwds, self, role);
}
```

Becomes:

```ts
{
  (terminals, statuses, cwds, contexts, self, role);
}
// where contexts: Record<string, ContextSnapshot>
```

The text body also gets the `· 45K/200K (23%)` segment appended after `statusStr`.

`renderResult` formatter follows the same pattern: `dim` styling for the context segment, same separator (`·`).

### 8. Skill file update

`skills/pi-link-coordination/SKILL.md` describes `/link` output format. Add one line documenting the new context segment so the agent knows what it's looking at.

## Edge cases

| Case                                                      | Behavior                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ctx` is undefined (pre-init)                             | `captureContext()` returns undefined → send `context: null` → peers clear, display shows just `idle (2m)`     |
| `getContextUsage()` returns undefined (no model selected) | Same as above                                                                                                 |
| Context was present, becomes unavailable (model deselected) | Terminal sends `context: null` → hub/clients **delete** stored entry → display drops segment (no stale value) |
| `tokens` is null (post-compaction)                        | Send `{ tokens: null, contextWindow: N }` → display shows `?/200K` (valid data, not a clear)                 |
| `contextWindow` is 0                                      | `captureContext()` returns undefined → send `context: null` → peers clear                                    |
| Old terminal (0.1.14 or earlier) connects                 | Doesn't send context field → maps stay empty for that terminal → display omits segment for that terminal only |
| Self-context                                              | `getContextFor(self)` calls `captureContext()` directly, always fresh                                         |
| Status push during streaming                              | Existing cadence applies (agent_start, tool boundaries, agent_end) — no new high-frequency pushes             |
| Context unchanged but status flips kind                   | Push fires for status reason; context piggybacks                                                              |
| Context changed but status kind same                      | New: dedup now considers context, push fires                                                                  |
| Welcome without contexts field (old hub)                  | New client absorbs nothing; populates as updates arrive                                                       |

## Backwards compatibility

- Wire format changes are purely additive — all new fields optional
- 0.1.14 hubs ignore unknown `context` fields (JSON parse drops nothing; the field just sits unused)
- 0.1.14 clients receiving a status_update with extra fields ignore them (TS structural typing means `JSON.parse` returns the extra props but the message-handler switch doesn't reference them)
- 0.1.15+ clients connecting to a 0.1.14 hub: hub forwards status_updates as-is, but the hub itself doesn't send context for its own terminal. Mixed-version display: 0.1.15 sees context for other 0.1.15s; 0.1.14 hub appears without context. Acceptable
- No changes to `register` / `welcome` semantics — new fields ignored by old terminals

## Testing plan

Manual smoke (10 cases, similar pattern to 0.1.14 batch):

| #   | Case                                                                                     | Verifier                                  |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | Fresh terminal idle: `/link` shows context segment after first prompt                    | Visible in output                         |
| 2   | Fresh terminal pre-prompt (no usage yet): `/link` omits segment                          | Visible in output                         |
| 3   | Mid-tool execution: status shows `tool:X (Ns)` AND context                               | Visible in output                         |
| 4   | After compaction: `?/200K` shown briefly, then `~/200K` after next turn                  | Visible across two `/link` invocations    |
| 5   | Two terminals, one busy, one idle: `/link` correctly attributes context to each          | Compare outputs                           |
| 6   | `link_list` tool returns nested `contexts` field with correct shape                      | Inspect tool result JSON                  |
| 7   | 0.1.14 terminal joins 0.1.15 hub: 0.1.14 shows no context, 0.1.15 shows for 0.1.15 peers | Cross-version test if feasible, else skip |
| 8   | Hub failover: context state survives promotion (or starts fresh — document either way)   | Disconnect hub, observe                   |
| 9   | Long-running streaming: context pushes fire on agent_end, not per-token                  | Confirm by message-frequency observation  |
| 10  | `formatTokens` rounds correctly: 999 → `999`, 1500 → `2K`, 1500000 → `1.5M`              | Unit assertion or eyeball                 |
| 11  | Context-clearing: terminal reports context then loses it (`context: null`) → segment drops on peers, no stale value | Compare peer's `/link` before/after       |

Cases 1–6 are the smoke priorities. 7–11 are nice-to-have.

## Rollout

1. Implement in workshop (`index.ts` + `skills/pi-link-coordination/SKILL.md`)
2. GPT review pass
3. Bump version `0.1.15-dev` → `0.1.15-beta.0`, publish under `--tag beta`
4. Local install via `pi install npm:pi-link@0.1.15-beta.0`
5. Smoke test cases 1–6 manually (similar workflow to 0.1.14 batch)
6. Promote to `0.1.15`, publish without tag, drop `beta` tag
7. Add `## Unreleased` placeholder if 0.1.16 work begins

## Open questions / deferred decisions

- **Hub failover context state**: when the hub disappears and a client gets promoted, do we preserve `hubTerminalContexts` from the prior hub's state? (Probably no — follow existing cwd/status precedent: state rebuilds from new connections. Document either way.)
- **`link_list` JSON shape stability**: external consumers may script against the tool result. Adding `contexts` is additive — safe. Worth noting in CHANGELOG so anyone parsing it knows.

## CHANGELOG entry (draft)

```
## 0.1.15 — <date>

### Added

- **Context usage in `link_list` and `/link`.** Each terminal broadcasts its current LLM context (tokens used and window size) as part of its status updates. `/link` displays it inline as `45K/200K (23%)` after the status segment. The `link_list` tool returns nested `contexts: Record<name, { tokens, contextWindow }>`. Tokens may be `null` briefly after compaction; display falls back to `?/200K` then. Old terminals (0.1.14 and earlier) connect normally and simply omit the context segment in their entry.

```
