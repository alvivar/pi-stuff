# PLAN — Remote orchestration: compact, model, thinking (0.1.16+)

## Goal

Add three new pi-link tools that let an orchestrator terminal trigger runtime-state changes on a target terminal:

- `link_compact(target, instructions?)` — request `ctx.compact()` on target
- `link_set_model(target, provider, modelId)` — request `pi.setModel()` on target
- `link_set_thinking(target, level)` — request `pi.setThinkingLevel()` on target

Use case: an "archon" terminal observes worker context usage via `link_list` and proactively manages workers — compact when context fills, switch to cheaper model for grunt work, raise thinking for hard problems.

## Non-goals

- Remote tool registration / configuration / settings changes (only the three runtime levers above)
- Per-action consent toggles (one `/link-control allow|deny` gate covers all three)
- Whitelist by terminal name (names are mutable, not auth boundary)
- Synchronous wait-for-compaction-completion (compact stays fire-and-forget; tool returns "queued")
- Cross-action transactions ("set model AND compact AND set thinking" as one atomic call)

## Trust and consent model

**Default deny.** A terminal does not accept remote control unless its user explicitly enables it.

### `/link-control` slash command

```
/link-control              → show current state ("allowed" or "denied") + how to change
/link-control allow        → enable, persist session entry { customType: "link-control", data: { mode: "allow" } }
/link-control deny         → disable, persist session entry with mode: "deny"
```

On `session_start`: read latest `link-control` entry from session JSONL via `pi.getEntries()`, default to `"deny"` if absent. Same persistence pattern as `link-name`.

When state changes, broadcast updated `capabilities.remoteControl` to the link via a forced `pushStatus(true)` so other terminals' `link_list` reflects the new state.

### Source authority

Hub is authoritative for `from` field on incoming control messages, mirroring existing `chat` / `prompt_request` / `prompt_response` handling. No whitelist by name. Receiver-side opt-in is the only gate.

## Pi API references

```ts
// from dist/core/extensions/types.d.ts

interface ExtensionContext {
  compact(options?: CompactOptions): void; // fire-and-forget
  // ... other fields
}

interface ExtensionAPI {
  setModel(model: Model<any>): Promise<boolean>; // returns false if no API key
  setThinkingLevel(level: ThinkingLevel): void; // sync, clamped to model capabilities
  getThinkingLevel(): ThinkingLevel;
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// Model is resolved via ctx.modelRegistry — see "Model resolution" below
```

## Wire protocol

New message types, modeled on existing `prompt_request` / `prompt_response`:

```ts
interface ControlRequestMsg {
  type: "control_request";
  id: string;
  from: string;
  to: string;
  action: "compact" | "set_model" | "set_thinking";
  params: ControlParams;
}

type ControlParams =
  | { action: "compact"; instructions?: string }
  | { action: "set_model"; provider: string; modelId: string }
  | { action: "set_thinking"; level: ThinkingLevel };

interface ControlResponseMsg {
  type: "control_response";
  id: string;
  from: string; // responder
  to: string; // original requester
  result: ControlResult;
}

type ControlResult =
  | { ok: true; action: "compact"; queued: true }
  | { ok: true; action: "set_model"; previous: ModelRef; current: ModelRef }
  | {
      ok: true;
      action: "set_thinking";
      previous: ThinkingLevel;
      current: ThinkingLevel;
      clamped?: boolean;
    }
  | { ok: false; reason: ControlErrorReason; message: string };

type ModelRef = { provider: string; modelId: string };

type ControlErrorReason =
  | "denied" // receiver has /link-control deny
  | "busy" // target not idle (agent_running or pending_remote_prompt)
  | "not_found" // target terminal not connected
  | "model_not_found" // requested model doesn't exist in receiver's registry
  | "no_api_key" // setModel returned false
  | "no_op" // already on requested model/level
  | "cooldown" // compact called within cooldown window
  | "unsupported" // target doesn't advertise capabilities.remoteControl (older version)
  | "invalid_params" // params validation failed
  | "shutdown" // target shutting down mid-request
  | "timeout" // request timed out
  | "aborted"; // orchestrator aborted
```

Routing: hub forwards `control_request` and `control_response` between clients identically to existing `prompt_*` messages, with `from` normalized to the hub's authoritative client→name mapping.

## Capabilities advertisement

Builds on the `capabilities` field shipped in 0.1.15 context-display work. In 0.1.15 every terminal advertises `{ remoteControl: false }`. In 0.1.16+:

```ts
type Capabilities = {
  remoteControl?: boolean; // true ⇔ /link-control allow currently set
};
```

Broadcast on:

- Initial `register` message
- Every `status_update` (rides existing cadence; cheap)
- Forced push on `/link-control` state change

Other terminals store per-name capabilities in `hubTerminalCapabilities` / `terminalCapabilities` maps (mirrors cwds/contexts). Orchestrator-side tools read this map _before_ sending a request — if `target.capabilities?.remoteControl !== true`, return `unsupported` immediately without going over the wire.

## Status payload extensions for verification

To let orchestrator verify state changes via `link_list` rather than relying solely on response:

```ts
interface StatusUpdateMsg {
  type: "status_update";
  name: string;
  status: LinkStatus;
  context?: ContextSnapshot; // from 0.1.15
  capabilities?: Capabilities; // from 0.1.15 (now meaningful)
  model?: ModelRef; // NEW in 0.1.16
  thinkingLevel?: ThinkingLevel; // NEW in 0.1.16
}
```

Pushed on the same events as context: `agent_start`, `agent_end`, `tool_execution_*`, `session_compact`, plus the new event:

- **`session_model_change`** — does Pi expose this? Check `dist/core/extensions/types.d.ts` for events. If not present, push synchronously inside `link_set_model` after `pi.setModel()` resolves.
- **`session_thinking_change`** — same question. If not exposed, push synchronously after `pi.setThinkingLevel()`.

(Action item during implementation: verify event names. Fall back to forced push from inside the action handler if no event exists.)

## Tool surface

### `link_compact`

```ts
parameters: Type.Object({
  to: Type.String({ description: "Target terminal name" }),
  instructions: Type.Optional(
    Type.String({
      description: "Custom compaction instructions for the target",
    }),
  ),
});
```

Behavior:

1. Pre-validate: target exists in `connectedTerminals`, target is not self
2. Pre-check capabilities: `target.capabilities.remoteControl === true` → else return `unsupported`
3. Send `control_request` with action="compact", await `control_response`
4. Tool result reports outcome (queued / denied / busy / cooldown / unsupported)

Receiver side:

1. Validate consent: `linkControlMode === "allow"` → else respond `denied`
2. Validate idle: `!agentRunning && !pendingRemotePrompt` → else respond `busy`
3. Validate cooldown: `Date.now() - lastCompactTime > COMPACT_COOLDOWN_MS` → else respond `cooldown`
4. `lastCompactTime = Date.now()`
5. Call `ctx.compact({ customInstructions: params.instructions })` — fire-and-forget per Pi API
6. Respond `ok: true, queued: true`
7. Toast: `"opus@pi-link requested compact"` (info)
8. Append session entry `{ customType: "link-control-action", data: { from, action: "compact", instructions } }`

### `link_set_model`

```ts
parameters: Type.Object({
  to: Type.String({ description: "Target terminal name" }),
  provider: Type.String({
    description: "Provider name (e.g. anthropic, openai, google)",
  }),
  modelId: Type.String({
    description: "Model ID (e.g. claude-sonnet-4-20250514)",
  }),
});
```

Behavior:

1. Standard pre-validation as above
2. Send `control_request` with action="set_model", params={provider, modelId}, await response

Receiver side:

1. Consent + idle checks
2. Resolve model: `ctx.modelRegistry.getModel(provider, modelId)` — fail with `model_not_found` if absent
3. Capture current model: `ctx.model` — if same id and provider, respond `no_op` with current state
4. Call `pi.setModel(model)` — async, returns boolean
5. If false: respond `no_api_key, message: "no API key for ${provider}"`
6. If true: respond `ok: true, previous: <prior>, current: <new>`
7. Toast: `"opus@pi-link switched model to ${current.modelId} ✓"` (info on success, warning on failure)
8. Audit entry persisted

### `link_set_thinking`

```ts
parameters: Type.Object({
  to: Type.String({ description: "Target terminal name" }),
  level: Type.Union(
    [
      Type.Literal("off"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
    ],
    { description: "Thinking level" },
  ),
});
```

Note: per Pi extensions docs, `Type.Union` of `Type.Literal` may not work with Google's API. If pi-link extension targets Google models, switch to `StringEnum` from `@mariozechner/pi-ai`. Verify during implementation.

Behavior:

1. Standard pre-validation
2. Send `control_request` with action="set_thinking", params={level}

Receiver side:

1. Consent + idle checks
2. Capture current: `pi.getThinkingLevel()`
3. If same: respond `no_op` with current state
4. Call `pi.setThinkingLevel(level)` — sync, may clamp
5. Re-read `pi.getThinkingLevel()` — if clamped to a different value, set `clamped: true` in response
6. Respond `ok: true, previous, current, clamped?`
7. Toast: `"opus@pi-link set thinking to ${current}"` or `"...to ${requested} (clamped to ${current})"`
8. Audit entry persisted

## Cooldowns and no-op detection

| Action       | Cooldown                                                                                        | No-op condition                        |
| ------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------- |
| compact      | 60s minimum between requests, **per receiver** (one timer, regardless of orchestrator identity) | Never — always perform if allowed      |
| set_model    | None                                                                                            | Same `provider` + `modelId` as current |
| set_thinking | None                                                                                            | Same level as `pi.getThinkingLevel()`  |

`COMPACT_COOLDOWN_MS = 60_000`. Stored as receiver-side state: `let lastCompactTime = 0`.

Why per-receiver, not per-(orchestrator, receiver)? Because the cooldown protects the receiver from churn, regardless of how many orchestrators are active. Two orchestrators each sending a compact in 30s → second one rejected with `cooldown` even though it came from a different sender. That's correct.

## Idle gating

Reject with `busy` when `agentRunning || pendingRemotePrompt`. Don't queue. Pi might queue mid-stream calls itself, but we don't trust that — explicit reject keeps semantics simple. Orchestrator can retry.

Edge case: target receives control_request, passes idle check, then immediately starts an agent turn (race). Receiver-side: capture state, execute synchronously within the message handler before returning to the event loop. `pi.setModel` is async though — TODO during implementation: figure out how to handle a race where agent_start fires while setModel is pending. Worst case: setModel completes after a turn started, model takes effect on next turn. Acceptable.

## Implementation outline (`index.ts`)

### 1. State additions

```ts
let linkControlMode: "allow" | "deny" = "deny";
let lastCompactTime = 0;
const COMPACT_COOLDOWN_MS = 60_000;

const hubTerminalCapabilities = new Map<string, Capabilities>();
const terminalCapabilities = new Map<string, Capabilities>();
const hubTerminalModels = new Map<string, ModelRef>();
const terminalModels = new Map<string, ModelRef>();
const hubTerminalThinking = new Map<string, ThinkingLevel>();
const terminalThinking = new Map<string, ThinkingLevel>();

const pendingControlResponses = new Map<
  string,
  {
    resolve: (result: ToolResult) => void;
    targetName: string;
    inactivityTimeout: ReturnType<typeof setTimeout>;
    ceilingTimeout: ReturnType<typeof setTimeout>;
  }
>();
```

### 2. Restore link-control mode on session_start

In the existing `session_start` handler, after restoring link-name, scan entries for `link-control`:

```ts
const entries = ctx.sessionManager.getEntries();
for (let i = entries.length - 1; i >= 0; i--) {
  const e = entries[i] as {
    type: string;
    customType?: string;
    data?: { mode?: unknown };
  };
  if (e.type === "custom" && e.customType === "link-control") {
    if (e.data?.mode === "allow" || e.data?.mode === "deny") {
      linkControlMode = e.data.mode;
    }
    break;
  }
}
```

### 3. `/link-control` slash command

```ts
pi.registerCommand("link-control", {
  description:
    "Allow or deny remote control actions from other terminals (default: deny)",
  handler: async (args, _ctx) => {
    const arg = args.trim().toLowerCase();
    if (!arg) {
      _ctx.ui.notify(
        `link-control: ${linkControlMode}. Use /link-control allow|deny`,
        "info",
      );
      return;
    }
    if (arg !== "allow" && arg !== "deny") {
      _ctx.ui.notify(
        `Invalid argument "${arg}". Use /link-control allow|deny`,
        "warning",
      );
      return;
    }
    if (arg === linkControlMode) {
      _ctx.ui.notify(`link-control already ${arg}`, "info");
      return;
    }
    linkControlMode = arg;
    pi.appendEntry("link-control", { mode: arg });
    pushStatus(true); // broadcast new capabilities
    _ctx.ui.notify(`link-control: ${arg}`, "info");
  },
});
```

### 4. Capabilities derivation in `pushStatus`

```ts
function selfCapabilities(): Capabilities {
  return { remoteControl: linkControlMode === "allow" };
}
```

Add to status push payload (extends 0.1.15 work):

```ts
const msg: StatusUpdateMsg = {
  type: "status_update",
  name: terminalName,
  status,
  ...(context ? { context } : {}),
  capabilities: selfCapabilities(),
  ...(currentModelRef() ? { model: currentModelRef() } : {}),
  thinkingLevel: pi.getThinkingLevel(),
};
```

`currentModelRef()`:

```ts
function currentModelRef(): ModelRef | undefined {
  const m = ctx?.model;
  if (!m) return undefined;
  return { provider: m.provider, modelId: m.id };
}
```

Extend `pushStatus` dedup comparison to include capabilities, model, thinking:

```ts
function sameCapabilities(a, b) {
  return a?.remoteControl === b?.remoteControl;
}
function sameModelRef(a, b) {
  return a?.provider === b?.provider && a?.modelId === b?.modelId;
}
```

### 5. Hub forwarding for control_request / control_response

In `hubHandleClient`, extend the routing block:

```ts
if (
  msg.type === "chat" ||
  msg.type === "prompt_request" ||
  msg.type === "prompt_response" ||
  msg.type === "control_request" ||
  msg.type === "control_response"
) {
  routeMessage({ ...msg, from: clientName });
}
```

### 6. Receiver-side handling

Extend the message switch in the client/hub local handler to add cases for `control_request`. Outline:

```ts
case "control_request":
  handleControlRequest(msg);
  break;

case "control_response": {
  const pending = cleanupPendingControl(msg.id);
  if (pending) {
    pending.resolve(controlResultToToolResult(msg));
  }
  break;
}
```

`handleControlRequest`:

```ts
async function handleControlRequest(msg: ControlRequestMsg) {
  const respond = (result: ControlResult) => {
    routeMessage({
      type: "control_response",
      id: msg.id,
      from: terminalName,
      to: msg.from,
      result,
    });
  };

  if (linkControlMode !== "allow") {
    return respond({
      ok: false,
      reason: "denied",
      message: "Receiver has /link-control deny",
    });
  }
  if (agentRunning || pendingRemotePrompt) {
    return respond({
      ok: false,
      reason: "busy",
      message: "Target is not idle",
    });
  }

  switch (msg.params.action) {
    case "compact": {
      const now = Date.now();
      if (now - lastCompactTime < COMPACT_COOLDOWN_MS) {
        const remaining = Math.ceil(
          (COMPACT_COOLDOWN_MS - (now - lastCompactTime)) / 1000,
        );
        return respond({
          ok: false,
          reason: "cooldown",
          message: `Compact cooldown ${remaining}s remaining`,
        });
      }
      lastCompactTime = now;
      ctx?.compact({ customInstructions: msg.params.instructions });
      pi.appendEntry("link-control-action", {
        from: msg.from,
        action: "compact",
        instructions: msg.params.instructions,
      });
      ctx?.ui.notify(`"${msg.from}" requested compact`, "info");
      return respond({ ok: true, action: "compact", queued: true });
    }
    case "set_model": {
      const model = ctx?.modelRegistry.getModel(
        msg.params.provider,
        msg.params.modelId,
      );
      if (!model) {
        return respond({
          ok: false,
          reason: "model_not_found",
          message: `${msg.params.provider}/${msg.params.modelId} not found`,
        });
      }
      const previous = currentModelRef();
      if (
        previous &&
        previous.provider === msg.params.provider &&
        previous.modelId === msg.params.modelId
      ) {
        return respond({
          ok: false,
          reason: "no_op",
          message: "Already on requested model",
        });
      }
      const ok = await pi.setModel(model);
      if (!ok) {
        return respond({
          ok: false,
          reason: "no_api_key",
          message: `No API key for ${msg.params.provider}`,
        });
      }
      const current = currentModelRef()!;
      pushStatus(true);
      pi.appendEntry("link-control-action", {
        from: msg.from,
        action: "set_model",
        model: current,
      });
      ctx?.ui.notify(
        `"${msg.from}" switched model to ${current.modelId}`,
        "info",
      );
      return respond({
        ok: true,
        action: "set_model",
        previous: previous!,
        current,
      });
    }
    case "set_thinking": {
      const previous = pi.getThinkingLevel();
      if (previous === msg.params.level) {
        return respond({
          ok: false,
          reason: "no_op",
          message: "Already at requested level",
        });
      }
      pi.setThinkingLevel(msg.params.level);
      const current = pi.getThinkingLevel();
      const clamped = current !== msg.params.level;
      pushStatus(true);
      pi.appendEntry("link-control-action", {
        from: msg.from,
        action: "set_thinking",
        level: current,
        clamped,
      });
      ctx?.ui.notify(
        `"${msg.from}" set thinking to ${current}${clamped ? ` (clamped from ${msg.params.level})` : ""}`,
        "info",
      );
      return respond({
        ok: true,
        action: "set_thinking",
        previous,
        current,
        clamped,
      });
    }
  }
}
```

### 7. Tool implementations

Mirror `link_prompt`'s request/response timeout pattern. Per-tool:

```ts
async function sendControlRequest(
  target: string,
  params: ControlParams,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  if (role === "disconnected") return notConnectedResult();
  if (target === terminalName)
    return textResult("Cannot control yourself", { error: "self_target" });
  if (!connectedTerminals.includes(target)) {
    return textResult(`Terminal "${target}" not found`, { error: "not_found" });
  }

  // Pre-check capabilities
  const caps = (
    role === "hub" ? hubTerminalCapabilities : terminalCapabilities
  ).get(target);
  if (caps?.remoteControl !== true) {
    return textResult(`Target "${target}" does not accept remote control`, {
      error: "unsupported",
      target,
    });
  }

  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    // ... timeout setup, abort handling, route message — mirrors link_prompt
  });
}
```

`CONTROL_INACTIVITY_TIMEOUT_MS = 30_000` (compact takes a beat; model resolution could be slower than chat).
`CONTROL_HARD_CEILING_MS = 60_000`.

Each of the three tools (`link_compact`, `link_set_model`, `link_set_thinking`) is a thin wrapper around `sendControlRequest` with appropriate `params` and `parameters` schema.

### 8. Skill file update

`skills/pi-link-coordination/SKILL.md` — document the three new tools, their consent model, and how to read `capabilities.remoteControl` from `link_list` results before attempting actions. Critical: instruct the LLM not to assume any target accepts orchestration; check capabilities first.

### 9. README + CHANGELOG

README adds a section explaining `/link-control` and the orchestration tools. CHANGELOG entry below.

## Edge cases

| Case                                                                            | Behavior                                                                                                          |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Orchestrator sends to target with `remoteControl: false`                        | Pre-check blocks before sending → tool returns `unsupported` immediately                                          |
| Pre-check passes (caps cached as true), but receiver toggled to deny mid-flight | Receiver responds `denied` → tool returns error                                                                   |
| Target disconnects mid-request                                                  | Inactivity/ceiling timeout fires → tool returns `timeout`                                                         |
| Receiver shuts down between request and response                                | `session_shutdown` handler should drain pending control responses, but if not: timeout fires                      |
| `setModel` succeeds but `pushStatus` race makes status briefly stale            | Acceptable; next push overwrites                                                                                  |
| Compact called with cooldown remaining                                          | Receiver responds `cooldown` with seconds-remaining hint                                                          |
| Multiple orchestrators send compact simultaneously                              | First wins; second gets `cooldown`                                                                                |
| Thinking level invalid (typo)                                                   | Caught by typebox validation at orchestrator side; tool errors before send                                        |
| Receiver allows control then disconnects → reconnects with allow persisted      | Restored from session entries on next `session_start`                                                             |
| Hub failover: hub had control state for clients; new hub doesn't                | New hub rebuilds from incoming status_updates; brief window of stale "everyone unsupported" until next push cycle |
| Orchestrator on 0.1.16, target on 0.1.15                                        | Target's capabilities is `{remoteControl: false}` → unsupported, clean error                                      |
| Both on 0.1.14 (no capabilities field)                                          | Target's capabilities is undefined → treated as remoteControl: false → unsupported                                |

## Backwards compatibility

- All wire format additions optional
- 0.1.15 terminals advertise `capabilities: { remoteControl: false }` always (no `/link-control` command exists), so 0.1.16 orchestrators correctly identify them as unable to accept control
- 0.1.14 terminals don't advertise capabilities at all → undefined → also treated as unsupported
- 0.1.16 hub forwarding new message types (`control_request`, `control_response`): older clients ignore unknown types in their switch; messages just get dropped on the floor at older endpoints. Since pre-check filters by `capabilities.remoteControl`, an orchestrator on 0.1.16 won't actually send to a non-supporting target.

## Testing plan

This is the harder smoke. Spread across 2–3 test agents to exercise multi-terminal flows.

### Single-terminal sanity (10 cases)

| #   | Case                                                                              | Verifier                                                     |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `/link-control` with no arg → shows current state                                 | Toast/output contains "deny"                                 |
| 2   | `/link-control allow` → toast confirms, capabilities broadcast                    | `link_list` from another terminal shows remoteControl: true  |
| 3   | `/link-control deny` → toast confirms, broadcast updated                          | Other terminal's `link_list` shows remoteControl: false      |
| 4   | `/link-control invalid` → warning, no state change                                | Visible                                                      |
| 5   | `/link-control allow` then restart same session → restored as allow               | Reopen with `--continue`, verify `/link-control` shows allow |
| 6   | `/link-control allow` then `deny` then `allow` → 3 entries persisted, latest wins | Inspect JSONL                                                |
| 7   | Capabilities visible in `link_list` JSON for self                                 | Inspect tool result                                          |
| 8   | Capabilities visible in `link_list` JSON for other terminals                      | Cross-terminal observation                                   |
| 9   | Status push fires on `/link-control` toggle (force=true)                          | Observe via second terminal's `link_list` updating           |
| 10  | Pre-check blocks orchestration tools when target has remoteControl: false         | Tool returns error, no wire message sent                     |

### Compact (8 cases)

| #   | Case                                                                                | Verifier                                                         |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 11  | Target denied → orchestrator gets `denied`                                          | Tool result has reason: denied                                   |
| 12  | Target allowed, idle → tool returns `queued: true`, target sees toast + audit entry | Cross-observation                                                |
| 13  | Target allowed, busy (mid-LLM) → orchestrator gets `busy`                           | Use prompt_request to keep target busy, then trigger compact     |
| 14  | Cooldown blocks second compact within 60s → `cooldown` with remaining seconds       | Two compacts in quick succession                                 |
| 15  | Cooldown clears after 60s → second compact succeeds                                 | Wait + retry                                                     |
| 16  | Compact instructions parameter forwarded to target                                  | Inspect target's session for compaction with custom instructions |
| 17  | Target offline → tool returns `not_found` immediately                               | Use disconnected target name                                     |
| 18  | Self-target → tool returns `self_target`                                            | `link_compact(opus@pi-link)` from opus@pi-link                   |

### set_model (8 cases)

| #   | Case                                                                       | Verifier                            |
| --- | -------------------------------------------------------------------------- | ----------------------------------- |
| 19  | Valid model + API key → success, target switches, status broadcast updated | `link_list` after shows new model   |
| 20  | Same model as current → `no_op`                                            | Tool result reason: no_op           |
| 21  | Unknown provider/modelId → `model_not_found`                               | Tool result reason: model_not_found |
| 22  | Valid model but no API key → `no_api_key`                                  | Tool result reason: no_api_key      |
| 23  | Target denied → `denied`                                                   | Standard                            |
| 24  | Target busy → `busy`                                                       | Standard                            |
| 25  | Status broadcast verifies the change (orchestrator can poll `link_list`)   | Observe                             |
| 26  | Audit entry persisted in target session                                    | Inspect JSONL                       |

### set_thinking (6 cases)

| #   | Case                                                                                                         | Verifier                        |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| 27  | Valid level (e.g. "high") → success, status updated                                                          | `link_list` shows thinkingLevel |
| 28  | Same level → `no_op`                                                                                         | Tool result reason: no_op       |
| 29  | Level clamped (model only supports `low/medium`, request `xhigh`) → `clamped: true`, current = clamped value | Tool result clamped flag        |
| 30  | Invalid level (typo) → typebox validation error before send                                                  | Tool errors at orchestrator     |
| 31  | Target denied → `denied`                                                                                     | Standard                        |
| 32  | Target busy → `busy`                                                                                         | Standard                        |

### Cross-version (2 cases, optional)

| #   | Case                                                                         | Verifier                    |
| --- | ---------------------------------------------------------------------------- | --------------------------- |
| 33  | 0.1.16 orchestrator sends to 0.1.15 target → `unsupported`, no wire message  | Pre-check works             |
| 34  | 0.1.16 orchestrator sends to 0.1.14 target (no capabilities) → `unsupported` | Pre-check handles undefined |

**Total: 34 cases.** Roughly 2x the 0.1.14 batch. Spread across multiple test agents.

Smoke priorities: 1, 2, 5, 11, 12, 14, 19, 21, 22, 27, 28, 29 — covers happy path + key error modes.

## Rollout

1. Implement in workshop (`index.ts` + slash command + skill + README)
2. GPT review pass — likely multiple rounds given surface size
3. Bump to `0.1.16-beta.0`, publish under `--tag beta`
4. Local install, run smoke priorities first
5. Full smoke if priorities pass
6. Iterate via beta.1, beta.2 as needed
7. Promote to `0.1.16`, drop beta tag

Estimated implementation: 200–300 LOC of new code in `index.ts` + ~60 LOC for slash command + skill/README updates. Bigger than 0.1.15.

## Open questions / deferred decisions

1. **Per-action consent toggles**: GPT recommended single gate. Should we leave the door open in the schema to add `acceptCompact`, `acceptModelSwitch`, `acceptThinking` later? (Yes — `Capabilities` type is open-ended; we'd add more boolean fields.)

2. **`session_model_change` / `session_thinking_change` events**: do these exist in Pi's API? If yes, hook them. If no, push from inside the action handler (already in the plan).

3. **Compact `wait` option**: if we want the tool to await compaction completion, add a `wait?: boolean` parameter. v1 ships fire-and-forget per Pi's API; revisit in v2 if orchestrators need synchronous feedback.

4. **Audit entry format**: should `link-control-action` include the orchestrator's full identity (terminal name + cwd?) or just name? Plan currently stores name. Worth deciding.

5. **`/link-control deny` while a control_request is mid-flight**: the request was already in flight when policy flipped. Receiver-side: re-check `linkControlMode` at handler entry (already in the plan), so the request gets `denied` even though pre-check passed. Already correct.

6. **Notification level for failures**: success → info, failure → warning? Or all info? Plan currently uses info for success, warning for setModel failure. Worth nailing down per action.

7. **`Type.Union<Type.Literal>` for ThinkingLevel parameter**: Pi extensions docs warn this doesn't work with Google's API. Need to verify or use `StringEnum` from `@mariozechner/pi-ai`.

## CHANGELOG entry (draft)

```
## 0.1.16 — <date>

### Added

- **Three new orchestration tools: `link_compact`, `link_set_model`, `link_set_thinking`.** An orchestrator terminal can request compaction, model switches, and thinking-level changes on another terminal. Targets must explicitly opt in via `/link-control allow`; default is deny. Each action surfaces a toast and audit entry on the receiver side. Compact has a 60s cooldown per target. Model switches return `no_op` if already on requested model; `model_not_found` if unknown; `no_api_key` if API key missing. Thinking level is clamped to model capabilities; `clamped: true` flag in result if downgraded. All actions reject with `busy` if target is mid-LLM-call or has pending remote prompts.

- **`/link-control allow|deny` slash command.** Toggles whether this terminal accepts remote control actions from other linked terminals. State persisted as session entry, restored on resume. Default: deny.

- **Status payload extended with `model` and `thinkingLevel`.** Orchestrators can verify state changes via `link_list` after issuing actions. Both fields appear in `link_list` tool results as `model: { provider, modelId }` and `thinkingLevel: <level>`.

- **`capabilities.remoteControl` now meaningful.** Previously always advertised as `false` in 0.1.15; now reflects each terminal's `/link-control` setting. Orchestrators check this before sending any control_request and short-circuit with `unsupported` if false.

### Changed

- Status broadcasts now also fire on `session_compact` (force-push), and on every `/link-control` toggle.
```
