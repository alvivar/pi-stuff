# .pi

My personal [Pi](http://pi.dev) config. Scrappy, opinionated, not meant for anyone else.

## Extensions

**`claude-code-provider`** — The big one (~2k lines). Wraps the `claude` CLI so I can use Claude Code headless mode as a Pi model. Streams `stream-json` output, keeps Claude sessions alive across turns with `--resume`, renders Claude's internal tool calls as compact inline traces (not Pi toolCalls — those have the wrong semantics here), handles `/compact` by summarizing and restarting the Claude session, and so on. Logs everything to `agent/debug.log`.

**`claude-subagent`** — Registers a `claude_subagent` tool so any model running in Pi can shell out to Claude Code for a subtask. Thread-based session reuse, `/claude <task>` shortcut.

## Skills

**`chrome-cdp-win`** — Windows fork of `pi-chrome-cdp`. The upstream skill uses Unix domain sockets for daemon IPC, which doesn't work on Windows. This fork uses named pipes (`//./pipe/cdp-<targetId>`), a registry file (`%TEMP%/cdp-daemons.json`) for daemon discovery, and fixes a bunch of other Windows-specific rough edges (screenshot paths, Chrome profile detection via `DevToolsActivePort`, help text). See its own `TODO.md` for known issues — registry file races, daemon crash cleanup, PID recycling.

## Docs

- `CLAUDE_CODE_PI_INTEGRATION_NOTES.md` — why Claude tool events can't be Pi toolCalls, and other architectural decisions
- `CLAUDE_CODE_PROVIDER_BEHAVIOR.md` — how the provider actually behaves (streaming, compaction, usage tracking, context meter)
- `CHROME-CDP-WINDOWS-FIX.md` — the original Unix socket → named pipe fix I applied to `pi-chrome-cdp` before forking it into a standalone skill
- `DEAD_KEY_BUG.md` — a dead key composition bug I hit in VSCode terminal
- `TODO.md` — what's left to do on the provider
- `agent/extensions/claude-code-headless.md` — reference for Claude Code's headless CLI API

## Also in here

- `agent/settings.json` — default model, theme, thinking level
- `agent/bin/` — bundled `rg.exe`, `fd.exe`
- `agent/sessions/` — session history (gitignored)
- `agent/debug.log` — diagnostics (gitignored)

## Setup

Needs the `claude` CLI on PATH (or set `CLAUDE_CLI_PATH`). Chrome CDP skill needs Chrome with remote debugging enabled.
