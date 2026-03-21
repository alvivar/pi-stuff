# .pi

My personal [Pi](http://pi.dev) config. Scrappy, opinionated, not meant for anyone else.

## Extensions

**`claude-code-provider`** — The big one (~2k lines). Wraps the `claude` CLI so I can use Claude Code headless mode as a Pi model. Streams `stream-json` output, keeps Claude sessions alive across turns with `--resume`, renders Claude's internal tool calls as compact inline traces (not Pi toolCalls — those have the wrong semantics here), handles `/compact` by summarizing and restarting the Claude session, and so on. Logs everything to `agent/debug.log`.

Docs live next to the code:

- `BEHAVIOR.md` — how the provider actually behaves (streaming, compaction, usage tracking, context meter)
- `INTEGRATION.md` — why Claude tool events can't be Pi toolCalls, and other architectural decisions
- `HEADLESS.md` — reference for Claude Code's headless CLI API
- `TODO.md` — what's left to do

**`claude-subagent`** — Registers a `claude_subagent` tool so any model running in Pi can shell out to Claude Code for a subtask. Thread-based session reuse, `/claude <task>` shortcut.

## Skills

**`chrome-cdp-win`** — Windows fork of `pi-chrome-cdp`. The upstream skill uses Unix domain sockets for daemon IPC, which doesn't work on Windows. This fork uses named pipes and per-daemon marker files for discovery. `HISTORY.md` has the backstory.

## Other docs

- `docs/dead-key-bug.md` — a dead key composition bug I hit in VSCode terminal (not tied to any extension)

## Setup

Needs the `claude` CLI on PATH (or set `CLAUDE_CLI_PATH`). Chrome CDP skill needs Chrome with remote debugging enabled.
