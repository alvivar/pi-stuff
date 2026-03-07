# Claude Code Provider → Pi Native Integration Ideas

## Goal

Make calls to Claude through the `claude-code` provider feel as native as possible to Pi, while preserving correct semantics and stable rendering.

## Core insight

Claude Code internal tool use is **not** the same as Pi native `toolCall`.

- **Pi `toolCall` means:** the assistant is asking **Pi** to execute a tool now.
- **Claude Code internal tool use means:** Claude already executed an internal/provider-side tool while composing one streamed response.

This mismatch is the root of the rendering and UX problems.

---

## Research findings

### 1. Pi assistant content model is limited

Pi assistant content supports only:

- `text`
- `thinking`
- `toolCall`

There is no native assistant content type for:

- display-only tool traces
- provider-observed tool activity
- non-executable inline tool events

So Claude internal tools do not have a perfect native representation today.

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

This explains earlier ordering artifacts.

### 5. Block-boundary whitespace is fragile in Pi

`AssistantMessageComponent` trims text/thinking blocks:

- `content.text.trim()`
- `content.thinking.trim()`

So blank lines added at text block boundaries are unreliable.

Reliable line breaks generally need to live **inside the same text block**, not across adjacent blocks.

---

## Conclusion

Within current Pi architecture, the least-wrong mapping is:

- Claude thinking → native Pi `thinking`
- Claude prose → native Pi `text`
- Claude internal tool activity → **not** native Pi `toolCall`

So inline text traces for Claude internal tools are not just a workaround — they are currently the best semantic fit available without changing Pi core.

---

## Practical implications

### What we should not do

- Do **not** emit Claude internal tool activity as Pi native `toolCall`s.
  - Pi will try to execute them.
  - Rendering order will still not be truly inline.

### What we can do today

- Keep Claude internal tools as inline text trace output.
- Make that trace compact, readable, and visually stable.
- Avoid artificial whitespace hacks across block boundaries.
- Prefer either:
  - one continuous text block when spacing must be preserved, or
  - explicit visible separators instead of relying on blank lines.

---

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

---

## Issues to solve one by one

### Issue 1: Define target UX clearly

Decide what ideal Claude provider output should look like in Pi.

Questions:

- Should internal tool traces always be shown?
- Should start lines be shown, or only end summaries?
- Should noisy tools like `TodoWrite` be collapsed or hidden?
- Should prose and tool traces appear in one continuous text flow or as visibly separated sections?

### Issue 2: Minimize tool trace noise

Current trace can still feel busy.

Ideas:

- show only `[tool #N end] ...`
- hide `start` lines for common tools
- collapse repeated reads/greps
- special-case noisy tools like `TodoWrite`

### Issue 3: Make spacing deterministic without hacks

Do not rely on provider-injected `\n\n` across text block boundaries.

Safer strategies:

- keep adjacent trace + prose in the same text block when a visual break is required
- or use explicit visible separators
- or accept no blank line and improve typography instead

### Issue 4: Reevaluate text block strategy

Investigate whether the provider should:

- keep per-upstream text block mapping
- or move to a simpler single-rendered-text-block model for all prose/trace content

Tradeoff:

- per-block mapping preserves upstream structure
- single-block rendering makes spacing and ordering much easier to control

### Issue 5: Distinguish semantic and visual layers

We should decide explicitly:

- what is truthfully assistant prose
- what is observational trace/debug info
- what belongs in `debug.log` only

Potential rule:

- user-facing prose in assistant text
- provider telemetry in debug log only
- only concise tool trace remains inline

### Issue 6: Decide how “native” should be defined

Possible definitions:

1. **Native-looking**: matches Pi visual style closely
2. **Native-semantic**: uses Pi abstractions correctly
3. **Native-interactive**: behaves naturally in streaming UI

We probably cannot get all three perfectly without Pi core changes.

### Issue 7: Propose Pi core enhancement

If we want a real long-term fix, propose a Pi enhancement for display-only inline provider tool events.

Could include:

- new content type
- new assistant message event types
- inline renderer support in `AssistantMessageComponent`
- agent-loop exclusion from tool execution

---

## Recommended near-term direction

1. Keep native `thinking` and native `text`.
2. Keep Claude internal tools as inline text trace.
3. Simplify trace formatting further.
4. Stop fighting block-boundary blank-line behavior.
5. If needed, use one shared text block for trace + prose when visual continuity matters more than upstream structural purity.
6. Consider a Pi core feature proposal for non-executable inline provider tool traces.

---

## Useful source references

- `docs/custom-provider.md`
- `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`
- `dist/modes/interactive/components/assistant-message.js`
- `dist/modes/interactive/components/tool-execution.js`
- `dist/modes/interactive/interactive-mode.js`
- `node_modules/@mariozechner/pi-ai/dist/types.d.ts`
