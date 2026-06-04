# PLAN — `link_compact` (leanest slice extracted from orchestration)

## Goal

One new tool, `link_compact(to, instructions?)`, that asks another terminal to compact its
context window. Fire-and-forget, modeled exactly on `link_send`. No consent, no capability
advertisement, no response message, no cooldown, no idle check.

## Use case & division of labor

An orchestrator watches worker context usage in `link_list` (shipped) and compacts a worker
when it gets too loaded, so the worker can finish a long todo without blowing its window.

- **pi-link provides the _action_** (`link_compact`) — nothing else.
- **The orchestrator LLM owns the _policy_** (the "keep it under 150K" threshold, when/whether
  to compact). No threshold config or auto-compact daemon in pi-link.

## Why this is the whole feature

Verification is **free**. We already force-push context on `session_compact`, so the orchestrator
simply watches the target's `link_list` context drop. No `compact_response` needed — the existing
context broadcast _is_ the ack.

## Non-goals (explicitly cut from PLAN-orchestration.md)

- Consent / `/link-control` gate, default-deny — **none**. Compact like any other link tool.
- Capability advertisement (`remoteControl` flag), `terminalCapabilities` maps — **none**.
- `compact_response` message, ACK/result reporting over the wire — **none** (verify via context).
- Cooldown, idle/busy check, audit session entry — **none**.
- `set_model` / `set_thinking`, model/thinking status fields, `model_select` triggers — **none**.
- Generic `control_request` union — replaced by a single concrete `compact_request`.
- Broadcast (`to: "*"`) compact — **disallowed**; single named target only (safer, simpler).

## Design

### 1. Wire message (one new type)

```ts
interface CompactRequestMsg {
  type: "compact_request";
  from: string;
  to: string;
  instructions?: string;
}
```

Add to the `LinkMessage` union (near `ChatMsg`, ~line 64). No response type.

### 2. Hub routing — authoritative `from`

Add `compact_request` to the normalize-and-forward list (~line 759), alongside
`chat` / `prompt_request` / `prompt_response`:

```ts
if (
  msg.type === "chat" ||
  msg.type === "prompt_request" ||
  msg.type === "prompt_response" ||
  msg.type === "compact_request"
) {
  routeMessage({ ...msg, from: clientName });
}
```

`routeMessage` already delivers to `to`. No other hub changes.

### 3. Receiver handler — mirror `case "prompt_request"` notify, then compact

In the client message switch, next to `case "chat"`:

```ts
case "compact_request":
  notify(`"${msg.from}" requested compact`, "info");
  ctx?.compact({ customInstructions: msg.instructions });
  break;
```

- `notify` helper exists (line 205); same info-toast pattern as `Running remote prompt from "..."`.
  This is the "same fashion as other tools" surfacing — the target's user sees who triggered it.
- `ctx?.compact()` — `ctx: ExtensionContext` (line 141); `CompactOptions.customInstructions` verified
  in types.d.ts (line 199). Fire-and-forget per API (returns void). The `?` guards print/RPC mode.

### 4. Tool — mirror `link_send` execute/renderCall/renderResult (~line 1163)

```ts
pi.registerTool({
  name: "link_compact",
  label: "Link Compact",
  description:
    "Ask another Pi terminal to compact its context window, freeing up space. " +
    "Fire-and-forget; watch link_list to see the target's context usage drop.",
  promptSnippet: "Ask another Pi terminal to compact its context window",
  parameters: Type.Object({
    to: Type.String({ description: "Target terminal name" }),
    instructions: Type.Optional(
      Type.String({ description: "Optional custom compaction instructions for the target" }),
    ),
  }),
  async execute(_toolCallId, params) {
    if (role === "disconnected") return notConnectedResult();
    if (params.to === terminalName)
      return textResult("Cannot compact self - use /compact.", { to: params.to, error: "self" });
    if (!connectedTerminals.includes(params.to))
      return textResult(
        `Terminal "${params.to}" not found. Connected: ${connectedTerminals.join(", ")}`,
        { to: params.to, error: "not_found" },
      );
    const delivered = routeMessage({
      type: "compact_request",
      from: terminalName,
      to: params.to,
      instructions: params.instructions,
    });
    if (!delivered)
      return textResult(`Failed to request compact on "${params.to}"`, {
        to: params.to,
        error: "not_delivered",
      });
    const verb = role === "hub" ? "Requested compact on" : "Requested compact (via hub) on";
    return textResult(`${verb} "${params.to}". Watch link_list for its context to drop.`, {
      to: params.to,
    });
  },
  // renderCall / renderResult: copy link_send's, dropping the message preview and
  // the (trigger) marker; show the target name + instructions preview if present.
});
```

Self-guard is the one tiny non-`link_send` addition (compacting self is a no-op surprise; `/compact`
is the local path). Everything else copies `link_send` verbatim, including `notConnectedResult`,
`textResult`, and the hub-vs-client wording.

### 5. Header + doc touch-ups

- index.ts line 9 comment: `Tools: link_send, link_prompt, link_list` → add `, link_compact`.
- **SKILL.md** (opus lane): one line in the tool reference — when `link_list` shows a worker's
  context high, `link_compact` it to free the window. This is how-to/mechanics → fits SKILL.
- **README** (docs lane, after implementation): `link_compact` in the "which tool" table + a
  `### link_compact` section + the new `compact_request` row in Internals Protocol. Delegate to docs.

## Edge cases (all acceptable for the lean slice)

- **Older pi-link target** (no handler): unknown message hits the switch default and is ignored —
  silent no-op. Orchestrator sees context not drop, infers it. No version gate needed.
- **Target busy / mid-turn**: we do NOT guard. `ctx.compact` is Pi's fire-and-forget; Pi decides
  timing. If this proves disruptive in practice, an idle guard is a later, separate change.
- **print/RPC mode receiver** (`ctx` undefined): `ctx?.compact` no-ops safely.

## Pi API references (verified)

```ts
// dist/core/extensions/types.d.ts
interface CompactOptions { customInstructions?: string; onComplete?; onError?; } // line 199
interface ExtensionContext { compact(options?: CompactOptions): void; }          // line 232
// session_compact event (line 411) already wired to force-push context (shipped).
```

## Implementation order

1. `CompactRequestMsg` type + union entry.
2. Hub normalize-and-forward entry.
3. Receiver `case "compact_request"`.
4. `link_compact` tool (copy `link_send`, add self-guard, swap wire type + wording).
5. Header comment + SKILL.md line.
6. esbuild bundle check (no local TS toolchain): `npx --yes esbuild index.ts --bundle
   --platform=node --format=esm --external:@earendil-works/* --external:ws --external:typebox
   --external:node:* --outfile=/tmp/pi-link-check.mjs`.
7. Live test (below), then delegate README to docs.

## Test plan

- **Happy path**: from one terminal, `link_compact` a test terminal that has meaningful context;
  confirm its `link_list` context drops (and `?/window` then a fresh count appears post-compaction).
- **Notify**: target shows the `"<from>" requested compact` info toast.
- **not_found**: `link_compact` a typo'd name → tool returns not_found with the connected list.
- **self**: `link_compact` own name → returns the self hint, no wire traffic.
- **instructions**: pass custom instructions; confirm they reach `ctx.compact` (target compaction
  honors them — best-effort visual check).
