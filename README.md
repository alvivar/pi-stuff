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

**`pi-mesh`** — Lets multiple local Pi terminals talk to each other over WebSocket on `localhost`. One terminal becomes the hub, the others join automatically. Adds `mesh_send`, `mesh_prompt`, and `mesh_list`, plus `/mesh`, `/mesh-name`, and `/mesh-broadcast`. Basically: terminal-to-terminal coordination for fan-out, research/build splits, or orchestrator/worker setups. Has its own `README.md`, and a `PLAN-broadcast-prompt.md` note for a possible fan-out prompt tool.

## Skills

**`chrome-cdp-win`** — Windows-only fork of `pi-chrome-cdp`. Same idea, but actually made to work properly on Windows. Uses named pipes plus per-daemon marker files in `%TEMP%` so daemon discovery, stop, cleanup, screenshots, and the rest behave sensibly. See `agent/skills/chrome-cdp-win/SKILL.md` for usage and `agent/skills/chrome-cdp-win/README.md` for the backstory.

## Other docs

- `docs/dead-key-bug.md` — a dead key composition bug I hit in VSCode terminal

## Setup

- Claude stuff needs the `claude` CLI on PATH (or `CLAUDE_CLI_PATH`)
- `pi-mesh` needs `npm install` in `agent/extensions/pi-mesh/`
- `chrome-cdp-win` needs Windows, Node.js 22+, and Chrome remote debugging enabled
