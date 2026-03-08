# Claude Code → Pi Integration Notes

This file captures the still-useful architectural notes for making the `claude-code` provider feel as native as possible in Pi without breaking semantics.

## Core insight

Claude Code internal tool use is **not** the same as Pi native `toolCall`.

- **Pi `toolCall` means:** the assistant is asking **Pi** to execute a tool now.
- **Claude Code internal tool use means:** Claude already executed an internal/provider-side tool while composing one streamed response.

This mismatch is the root of the rendering and UX problems.

## Pi constraints that matter

### 1. Pi assistant content model is limited

Pi assistant content supports only:

- `text`
- `thinking`
- `toolCall`

There is no native assistant content type for:

- display-only tool traces
- provider-observed tool activity
- non-executable inline tool events

So Claude internal tools do not currently have a perfect native representation.

### 2. Pi native `toolCall` has execution semantics

Pi agent loop interprets assistant `toolCall` blocks as executable requests.

After an assistant message ends, Pi scans assistant content for `toolCall` blocks and executes them.

That means if the Claude Code provider emits Claude internal tool usage as native Pi `toolCall`s, Pi will incorrectly treat them as:

> please execute these tools in Pi

That would be semantically wrong.

### 3. Pi interactive rendering does not preserve inline tool-call ordering

`AssistantMessageComponent` renders only:

- `text`
- `thinking`

It does **not** render `toolCall` blocks inline inside assistant content.

Instead, `interactive-mode.js` creates separate `ToolExecutionComponent`s and appends them directly to the chat container.

So tool calls are rendered as sibling UI components, not as true inline assistant content.

### 4. Visual order is not strict event-tape order

Even if a provider emits perfect event order, interactive mode re-renders from the full partial assistant message and separately manages tool execution components.

So interleaving like:

- text
- tool
- text

does not guarantee visual rendering in that same order.

### 5. Block-boundary whitespace is fragile in Pi

`AssistantMessageComponent` trims text/thinking blocks:

- `content.text.trim()`
- `content.thinking.trim()`

So blank lines added at text block boundaries are unreliable.

Reliable line breaks generally need to live **inside the same text block**, not across adjacent blocks.

## Practical conclusion

Within current Pi architecture, the least-wrong mapping is:

- Claude thinking → native Pi `thinking`
- Claude prose → native Pi `text`
- Claude internal tool activity → **not** native Pi `toolCall`

So inline text traces for Claude internal tools are not just a workaround — they are currently the best semantic fit available without changing Pi core.

## What this implies for the provider

### What we should not do

- Do **not** emit Claude internal tool activity as Pi native `toolCall`s.
  - Pi will try to execute them.
  - Rendering order will still not be truly inline.

### What we can do today

- Keep Claude internal tools as inline text trace output.
- Keep that trace compact, readable, and visually stable.
- Avoid artificial whitespace hacks across block boundaries.
- Prefer native Pi behavior where possible and provider-side formatting only where necessary.

## Long-term proper solution in Pi core

Pi likely needs a new assistant content type, something like:

- `providerToolTrace`
- `observedToolUse`
- `displayToolEvent`

Desired properties:

- inline in assistant content order
- display-only
- non-executable by agent loop
- renderable in interactive mode as part of assistant flow

That would allow Claude Code internal tool activity to feel truly native.

## Still-useful future directions

If this area is revisited later, likely questions are:

1. whether Pi core should add a display-only inline provider-event content type
2. whether Pi core should better distinguish semantic assistant content from observed provider telemetry
3. whether the provider should keep per-upstream text-block fidelity or simplify further if Pi rendering constraints demand it

## Useful source references

- `docs/custom-provider.md`
- `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`
- `dist/modes/interactive/components/assistant-message.js`
- `dist/modes/interactive/components/tool-execution.js`
- `dist/modes/interactive/interactive-mode.js`
- `node_modules/@mariozechner/pi-ai/dist/types.d.ts`
