# Claude Code Provider Behavior

This file documents the current behavior of `agent/extensions/claude-code-provider/index.ts`.

## Current Status

The provider currently supports:

- Claude CLI session continuity via `--resume`
- stream-keyed session continuity using the current Pi session id + model id
- reset-safe session continuity so `/claude-code-new-session` cannot be silently undone by an older in-flight stream finishing later
- Pi-native streaming with linear/as-it-arrives rendering protections
- visible inline tool traces in compact one-line form
- manual `/compact` session rebasing for the upstream Claude session
- context-meter behavior tuned to better reflect Claude Code's current top-level assistant-step prompt footprint
- total-cost capture from normal successful Claude turns
- deferred `/compact` cost capture, applied to the next successful fresh turn after bootstrap consumption
- helper commands for init diagnostics and clearing remembered Claude session state

## Streaming / Rendering

Current visible rendering behavior:

- assistant prose streams linearly
- tool traces remain visible by default
- visible tool traces use compact one-line summaries such as:
  - `↳ read — file=src/index.ts`
  - `↳ edit — file=src/index.ts old=158c new=163c`
- no visible tool numbering
- no visible start/end separators
- raw tool trace details remain in `~/.pi/agent/debug.log`

Current ordering protections:

- single render-source lock per response: `stream_event` or `assistant_snapshot`
- top-level-only snapshot fallback
- monotonic snapshot suffix growth only
- per-upstream text block mapping via `textIndexByBlock`
- parser tail guards to prevent post-final contamination

## `/compact` Semantics

For `claude-code`, `/compact` is implemented as a manual upstream Claude session rebase.

Current flow:

1. If there is no remembered Claude session for the current Pi session + model, `/compact` is cancelled with:
   - `No active Claude Code session to compact yet.`
2. If a remembered Claude session exists, the provider sends an internal no-tools summary request to the resumed Claude session.
3. Pi stores the returned compaction summary.
4. The provider clears the old remembered Claude session id.
5. The next normal user turn starts a fresh Claude session with the summary injected into the first user prompt only.
6. After that fresh turn succeeds and yields a new Claude `session_id`, the pending bootstrap state is marked consumed.

User-visible checkpoint notice:

- `Claude session checkpointed. Your next message will start a fresh Claude session from the compacted context.`

## Context Meter Behavior

### Intent

The Pi footer `%/ContextWindow` should be as in sync as possible with what Claude Code is doing, rather than with cumulative run accounting.

### Current behavior

The provider now separates two concepts:

- **run accounting** for input/output/cache/cost buckets
- **context estimate** for Pi's context meter

For Pi's context meter, the provider now prefers the latest **top-level assistant-step usage** observed during the Claude stream, rather than the final cumulative `result` usage.

Preferred sources, in practice:

- `stream_event.message_start.message.usage`
- `stream_event.message_delta.usage`
- top-level `assistant.message.usage`

That top-level assistant-step usage is used to set:

- `output.usage.totalTokens`

If no usable top-level assistant-step usage is captured for a turn, the provider falls back to the normal usage path already applied to the assistant message.

This means Pi's context `%` is driven by the latest top-level Claude assistant-step prompt footprint when available, which is much closer to current context occupancy than the final cumulative run usage.

### Why

Claude Code's final `result` usage is cumulative for the whole `claude -p` run and can include:

- multiple internal turns
- tool-loop activity
- cache reads/writes across those internal turns

That makes final result usage useful for billing/accounting, but not a good proxy for current context occupancy.

### Known limitation

This is still an approximation because Claude Code headless mode does not expose a clean authoritative "current session context size" field.

## Usage / Cost Accounting

### Current behavior

For normal successful Claude turns, the provider maps Claude CLI usage into Pi usage as follows:

- `input_tokens` -> `usage.input`
- `output_tokens` -> `usage.output`
- `cache_read_input_tokens` -> `usage.cacheRead`
- `cache_creation_input_tokens` -> `usage.cacheWrite`
- `total_cost_usd` -> `usage.cost.total`

Important distinction:

- `usage.input/output/cacheRead/cacheWrite/cost.total` are used for accounting
- `usage.totalTokens` is now primarily used to drive Pi's context meter and may intentionally differ from cumulative run accounting
- missing usage data is no longer normalized into a synthetic `totalTokens: 0`; bucket summation is only used when at least one real usage bucket is present

### Money fidelity

Current money behavior:

- **normal successful Claude turns**: total money is captured from Claude's final `total_cost_usd`
- **per-bucket dollar breakdown** (`cost.input`, `cost.output`, `cost.cacheRead`, `cost.cacheWrite`): not authoritative and intentionally not synthesized
- provider-registered model pricing remains zeroed to avoid inventing a fake breakdown from external pricing tables

### `/compact` cost accounting

The internal Claude call used to generate the compact summary is a real Claude invocation and therefore real spend.

Current behavior:

- the `/compact` summary call extracts its own `total_cost_usd`
- that cost is persisted with pending bootstrap state
- when the next fresh Claude session successfully consumes that bootstrap state, the stored compact cost is added once to that next assistant message's `usage.cost.total`

This means:

- `/compact` spend is now counted in Pi's cumulative money total
- but it is **deferred** until the next successful fresh turn after compaction, rather than appearing immediately as its own assistant line item
- if that next successful fresh turn never happens, the deferred compact spend remains staged rather than immediately visible in Pi totals

### Known limitations

Money accounting is still incomplete in a few edge cases:

- if Claude CLI omits `total_cost_usd`, fallback cost calculation is effectively zero because provider model pricing is zeroed
- failed/aborted internal or normal runs may still undercount spend if no usable final cost is available
- per-bucket dollar fields remain non-authoritative

## Provider Commands

Currently implemented provider-specific commands:

- `/claude-code-info`
  - shows the latest captured Claude Code init metadata
  - includes Claude Code version, model, tool summary, MCP summary, and capture timestamp
- `/claude-code-new-session`
  - clears remembered Claude session ids
  - clears pending bootstrap state and pending compaction staging state
  - clears cached init metadata
  - advances internal session-generation state so older in-flight Claude runs cannot write stale session ids back into provider memory after a reset

## Important State / Helpers

Key helper/state areas currently in use inside `agent/extensions/claude-code-provider/index.ts` include:

- session continuity:
  - `sessionMap`
  - `sessionState.generation`
  - `getClaudeSessionStreamKey(...)`
- pending compaction/bootstrap:
  - `PENDING_BOOTSTRAP_CUSTOM_TYPE`
  - `PENDING_BOOTSTRAP_CONSUMED_CUSTOM_TYPE`
  - `appendPendingBootstrapEntry(...)`
  - `appendPendingBootstrapConsumedEntry(...)`
  - `restorePendingBootstrapStateForStreamKey(...)`
  - `pendingBootstrapStateByStreamKey`
  - `pendingBootstrapAwaitingCompactionBySession`
- rendering/order:
  - `textIndexByBlock`
  - `thinkingIndexByBlock`
  - `pendingTraceJoinContentIndex`
  - render-source lock
- tool trace logging:
  - `debugToolTraceStart(...)`
  - `debugToolTraceEnd(...)`
- usage/context/cost:
  - `sumUsageTokenBuckets(...)`
  - `normalizeUsageLike(...)`
  - `extractUsage(...)`
  - `extractTopLevelAssistantStepUsage(...)`
  - `extractCompactResponseUsage(...)`
  - `applyUsage(...)`

## Useful Debug Log Events

Relevant events in `~/.pi/agent/debug.log`:

- session continuity / bootstrap:
  - `session_id`
  - `bootstrap_state_restored`
  - `bootstrap_state_consumed`
  - `session_state_writeback_skipped`
- compaction:
  - `compact_start`
  - `compact_cli_start`
  - `compact_cli_done`
  - `compact_summary_ready`
  - `compact_checkpointed`
  - `compact_error`
- usage / context / cost:
  - `usage`
  - `context_usage_candidate`
  - `context_usage_applied`
  - `compact_cost_applied_to_next_turn`
- tool traces:
  - `tool_trace_start`
  - `tool_trace_end`

## Open Gaps

Still worth validating further:

- long-run stress testing for rendering/order
- more manual validation of post-`/compact` behavior over multiple turns
- whether failed/aborted Claude calls should contribute spend when partial/final usage is available
- whether Pi core should eventually separate:
  - accounting usage
  - context-meter usage

## Canonical Files

Primary implementation file:

- `agent/extensions/claude-code-provider/index.ts`

Related planning docs in this repo:

- `COMPACT_REFACTOR.md`
- `TODO.md`
