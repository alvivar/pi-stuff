# Claude Code → Pi Tracking

Date: 2026-03-01
Scope: `agent/extensions/claude-code-provider/index.ts`

## Goal

Track Claude Code stream metadata that is available from `claude -p --output-format stream-json` but not currently surfaced in Pi.

## Current propagation (today)

The provider currently propagates:

- assistant text deltas (`text_delta`)
- thinking events (`thinking_start` / `thinking_delta` / `thinking_end`)
- usage totals (input/output/cache)
- session id (`session_id`)
- fallback final result text (`result`)
- rate-limit warning/info notices (when notable)
- run metadata notice (`duration_ms`, `num_turns`)
- init diagnostics via `/claude-code-info` (version/tools/MCP status)

The provider still does **not** propagate tool-use details into Pi UX.

## Gap matrix

| Data                        | Claude Code emits                                                              | Pi can consume                             | Currently propagated |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ | -------------------- |
| Thinking content            | `stream_event.content_block_delta.delta.type = "thinking_delta"`               | `thinking_start/delta/end`                 | ✅ Yes               |
| Tool calls                  | `content_block_start` (`content_block.type = "tool_use"`) + `input_json_delta` | `toolcall_start/delta/end`                 | ❌ No                |
| Rate limit info             | `type = "rate_limit_event"`                                                    | Side-channel (e.g. notify/log entry)       | ✅ Yes (text notice) |
| Duration / num_turns        | `type = "result"` with `duration_ms`, `num_turns`                              | Could append as metadata text/custom entry | ✅ Yes (text notice) |
| Claude Code version         | `type = "system"`, `subtype = "init"`, `claude_code_version`                   | Debug/diagnostics output                   | ✅ Yes (`/claude-code-info`) |
| Cache tier split (5m vs 1h) | `message_start.message.usage.cache_creation.*`                                 | Not modeled in Pi `Usage`                  | ❌ No                |

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
- Surface warning/info when overage/blocked states occur
- Capture `result.duration_ms`, `result.num_turns`
- Append brief telemetry lines to assistant output text:
  - `[claude-code rate-limit: ...]` (when notable)
  - `[claude-code: duration=..., turns=...]`

### P2 — Init diagnostics

**Status:** ✅ Implemented in `agent/extensions/claude-code-provider/index.ts`.

- Capture latest `system:init` payload in memory
- Add `/claude-code-info` to print version/tools/MCP status

### P3 — Tool-use visibility (opt-in)

- Map `tool_use` + `input_json_delta` to `toolcall_*` OR render as trace text
- Make opt-in to avoid noisy default UX
- Ensure no confusion with Pi-native executable tool loop semantics

### P4 — Cache tier fidelity (core change)

- Pi `Usage.cacheWrite` is a single field
- To preserve `ephemeral_5m` vs `ephemeral_1h`, Pi core usage schema must be extended

## Notes / constraints

- `streamSimple` has no direct `ctx.ui` access, so UI notifications require either:
  - provider-side text/metadata output, or
  - extension-level bridge (event/command/state) for UX notifications.
- Tool-use forwarding should be conservative to avoid implying Pi executed those tool calls directly.

## Definition of done (incremental)

### DoD for P0

- With `--effort` enabled, Pi renders thinking blocks in-stream (`thinking_start/delta/end`).
- No regressions in text streaming or final message assembly.

### DoD for P1

- `rate_limit_event` state visible to user (at least when not fully allowed).
- `duration_ms` + `num_turns` stored/surfaced per response.

### DoD for P3

- User can see Claude tool activity when enabled.
- Default behavior remains clean/non-noisy.

---

## Quick summary

**Thinking, P1 telemetry, and P2 init diagnostics are now implemented.** Next highest-value gap is opt-in tool-use visibility.
