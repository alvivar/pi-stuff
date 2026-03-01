# Claude Code → Pi Tracking

Date: 2026-03-01
Scope: `agent/extensions/claude-code-provider/index.ts`

## Goal

Track Claude Code stream metadata that is available from `claude -p --output-format stream-json` but not currently surfaced in Pi.

## Current propagation (today)

The provider currently propagates:

- assistant text in strict arrival order with per-upstream text block mapping (single-source per response: canonical `text_delta` by block index, or monotonic top-level assistant-snapshot suffix fallback)
- thinking events (`thinking_start` / `thinking_delta` / `thinking_end`)
- usage totals (input/output/cache)
- session id (`session_id`)
- fallback final result text (`result`) when no text deltas arrived
- rate-limit metadata capture (logged to `~/.pi/agent/debug.log`)
- run metadata capture (`duration_ms`, `num_turns`; logged to `~/.pi/agent/debug.log`)
- init diagnostics via `/claude-code-info` (version/tools/MCP status)
- tool-use streaming trace as assistant text lines (always on)

Tool-use visibility is always on (see P3).

## Gap matrix

| Data                        | Claude Code emits                                                              | Pi can consume                             | Currently propagated         |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------- |
| Thinking content            | `stream_event.content_block_delta.delta.type = "thinking_delta"`               | `thinking_start/delta/end`                 | ✅ Yes                       |
| Tool calls                  | `content_block_start` (`content_block.type = "tool_use"`) + `input_json_delta` | Assistant text trace lines                 | ✅ Yes (always-on trace)     |
| Rate limit info             | `type = "rate_limit_event"`                                                    | Side-channel (e.g. notify/log entry)       | ✅ Yes (debug log capture)   |
| Duration / num_turns        | `type = "result"` with `duration_ms`, `num_turns`                              | Could append as metadata text/custom entry | ✅ Yes (debug log capture)   |
| Claude Code version         | `type = "system"`, `subtype = "init"`, `claude_code_version`                   | Debug/diagnostics output                   | ✅ Yes (`/claude-code-info`) |
| Cache tier split (5m vs 1h) | `message_start.message.usage.cache_creation.*`                                 | Not modeled in Pi `Usage`                  | ❌ No                        |

## Evidence seen in local logs

From `agent/debug.log` samples:

- outer event types include: `system`, `stream_event`, `assistant`, `user`, `rate_limit_event`, `result`
- stream delta types include:
  - `thinking_delta`
  - `text_delta`
  - `input_json_delta`
  - `signature_delta`
- `system:init` includes `claude_code_version`, `tools`, `agents`, `skills`, `mcp_servers`
- `result` includes `duration_ms`, `duration_api_ms`, `num_turns`, and usage/cost payloads

## Prioritized implementation plan

### P0 — Thinking propagation (immediate)

**Status:** ✅ Implemented in `agent/extensions/claude-code-provider/index.ts`.

- Detect `content_block_start` where block type is `thinking`
- Map `thinking_delta` to Pi `thinking_delta`
- Emit `thinking_end` on `content_block_stop`

### P1 — Rate limit + run metadata

**Status:** ✅ Implemented in `agent/extensions/claude-code-provider/index.ts`.

- Parse top-level `rate_limit_event`
- Capture notable rate-limit state and log notice text to `~/.pi/agent/debug.log`
- Capture `result.duration_ms`, `result.num_turns` and log notice text to `~/.pi/agent/debug.log`
- Keep telemetry out of assistant prose to preserve linear content rendering

### P2 — Init diagnostics

**Status:** ✅ Implemented in `agent/extensions/claude-code-provider/index.ts`.

- Capture latest `system:init` payload in memory
- Add `/claude-code-info` to print version/tools/MCP status

### P3 — Tool-use visibility (always-on)

**Status:** ✅ Implemented as always-on trace in `agent/extensions/claude-code-provider/index.ts`.

- Maps `tool_use` + `input_json_delta` to assistant text trace lines (`[tool #N start|end] ...`) with concise, tool-specific argument summaries.
- Uses normalized tool names for readability (`Read/Edit/Write/Bash/Grep/Find/Ls` → lowercase).
- Chosen over `toolcall_*` UI blocks because interactive mode renders those as pending tool components at the chat bottom, which breaks chronological flow for trace-only (non-executed) Claude internal tools.
- Trace remains visibility-only; Pi does not execute Claude-internal tool calls.

### P4 — Cache tier fidelity (core change)

- Pi `Usage.cacheWrite` is a single field
- To preserve `ephemeral_5m` vs `ephemeral_1h`, Pi core usage schema must be extended

## Notes / constraints

- `streamSimple` has no direct `ctx.ui` access, so UI notifications require either:
  - provider-side text/metadata output, or
  - extension-level bridge (event/command/state) for UX notifications.
- Tool-use forwarding should be conservative to avoid implying Pi executed those tool calls directly.
- Streaming is event-linear with category-aware separators; when output category changes (e.g., prose ↔ tool trace), rendering inserts up to `\n\n` for readability.
- Tool trace entries include lightweight visual separators (`────────`) between completed tools to improve scanability in Pi's text renderer.
- Canonical `stream_event` prose is mapped per upstream content block index (not a single global text block) to preserve UI block order and avoid late-tail visual artifacts.
- `--include-partial-messages` is enabled, but rendering locks to a single source per response (`stream_event` or `assistant_snapshot`) to prevent cross-channel ordering drift.
- Snapshot fallback uses only top-level assistant/user events (`parent_tool_use_id == null`) and accepts monotonic suffix growth from one active assistant message id; other snapshot message ids are ignored for rendering.
- After the top-level `result` event is seen, subsequent stdout lines are ignored for rendering to prevent post-final tail glitches.

## Definition of done (incremental)

### DoD for P0

- With `--effort` enabled, Pi renders thinking blocks in-stream (`thinking_start/delta/end`).
- No regressions in text streaming or final message assembly.

### DoD for P1

- `rate_limit_event` state is captured and logged per response.
- `duration_ms` + `num_turns` are captured and logged per response.

### DoD for P3

- User can see Claude tool activity (always on).
- Tool activity appears in chronological chat flow as trace lines.

---

## Quick summary

**Thinking, P1 telemetry capture/logging, P2 init diagnostics, and P3 always-on tool-use trace are now implemented.** Remaining gap is cache-tier fidelity (5m vs 1h).
