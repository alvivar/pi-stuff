# Pi agent extensions

This directory contains extensions for the [Pi agent](http://pi.dev).

## Extensions

### `claude-code-provider`

**Path:** `agent/extensions/claude-code-provider/index.ts`

Registers a `claude-code` provider that lets Pi use your locally installed `claude` CLI as a model backend.

- Provider id: `claude-code`
- Model ids:
    - `claude-code-sonnet-4-6`
    - `claude-code-opus-4-6`
    - `claude-code-haiku-4-5`
    - (removed) the older `...-chat` / `...-agent` model ids are no longer registered
- Includes a command to clear the provider’s internal resume/session cache: `claude-code-new-session`
- Propagates Pi thinking level to Claude CLI via `--effort` (low/medium/high)
- Propagates Pi system prompt via `--append-system-prompt`

#### Design goals / important behavior

- Use Claude Code headless mode faithfully: prefer metadata and usage fields actually emitted by `claude -p --output-format stream-json` over inferred provider-side guesses.
- Preserve Claude CLI session continuity via `--resume`; Pi chat history is mainly display/UI state for this provider, while real conversational memory lives in the Claude CLI session.
- Keep streamed output visually stable and chronological in Pi.
- Make Claude internal tool activity feel native in Pi without pretending Pi executed those tools.

#### Streaming / rendering model

- The provider uses `--output-format stream-json --verbose --include-partial-messages`.
- Canonical prose rendering comes from Claude `stream_event` text deltas.
- Top-level assistant snapshots are used only as a monotonic suffix fallback when needed.
- Rendering is locked to a single source per response (`stream_event` or `assistant_snapshot`) to avoid cross-channel ordering drift.
- Claude internal `tool_use` events are rendered as inline assistant trace text, not Pi native `toolCall` blocks.
  - Reason: Pi treats native `toolCall` as executable intent and renders them as separate tool UI components, which is the wrong semantic and visual model for Claude-internal tools.
- Tool traces are always visible and currently use compact one-line summaries such as:
  - `↳ read — file=src/index.ts`
  - `↳ edit — file=src/index.ts old=158c new=163c`
- A completed trace text block may remain open for the next prose block so spacing stays reliable without invisible spacer hacks or block-boundary newline tricks.

#### Usage / cost fidelity policy

- Token buckets are mapped directly from Claude CLI output when present:
  - input
  - output
  - cache read
  - cache creation/write
- `total_cost_usd` from Claude CLI is treated as authoritative for `usage.cost.total` when present.
- The provider intentionally does **not** infer per-bucket USD costs from external pricing tables.
- Registered Pi model pricing for this provider remains zeroed on purpose so fallback Pi cost calculation does not invent a component breakdown Claude headless mode did not report.
- Claude exposes more cache detail than Pi’s current `Usage` model can represent (for example `cache_creation.ephemeral_5m_input_tokens` vs `ephemeral_1h_input_tokens`). Today that detail is collapsed when mapped into Pi `cacheWrite`.

#### Diagnostics / logging

- Raw provider diagnostics are appended to `~/.pi/agent/debug.log`.
- The provider captures/logs notable metadata including:
  - usage snapshots
  - rate-limit events
  - run metadata (`duration_ms`, `num_turns`)
  - `system:init` details for `/claude-code-info`
  - tool trace lifecycle entries (`tool_trace_start`, `tool_trace_end`)
- Response-end guards ignore late stdout lines after the final result to prevent post-final render contamination.

Environment variables supported by this extension include:

- `CLAUDE_CLI_PATH` (default: `claude`)
- `CLAUDE_CLI_TIMEOUT_SECONDS` (default: `240`)
- `CLAUDE_CLI_ALLOWED_TOOLS` (default: `Read,Edit,Write,Bash,Grep,Glob`)
- `CLAUDE_CLI_MODEL_SONNET_46`, `CLAUDE_CLI_MODEL_OPUS_46`, `CLAUDE_CLI_MODEL_HAIKU_45`
- `CLAUDE_CLI_APPEND_SYSTEM_PROMPT`

### `claude-subagent`

**Path:** `agent/extensions/claude-subagent/index.ts`

Registers a `claude_subagent` tool that delegates a task to the local `claude` CLI (via `claude -p`) and returns the result back into Pi.

- Tool name: `claude_subagent`
- Supports session reuse via `thread` (maps to `--resume` behind the scenes)
- Supports `--resume` / `--continue`, `--allowedTools`, and `--effort`
- Registers a convenience command: `claude` (usage: `/claude <task>`), which prompts Pi to call `claude_subagent`

## Configuration

Model enablement happens via Pi settings (see `agent/settings.json`). For example, this repo’s settings enable the `claude-code/...` models so they can be selected in Pi.

## Requirements

These extensions expect the `claude` CLI to be installed and available on your `PATH` (or configured via `CLAUDE_CLI_PATH`).
