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
