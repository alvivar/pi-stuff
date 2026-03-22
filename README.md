# .pi

My personal [Pi](http://pi.dev) config. Scrappy, opinionated, not meant for anyone else.


## Extensions

### [pi-mesh](agent/extensions/pi-mesh/)

Lets multiple local Pi terminals talk to each other over WebSocket on `localhost`. One terminal becomes the hub, the rest join automatically. Tools: `mesh_send`, `mesh_prompt`, `mesh_list`. Commands: `/mesh`, `/mesh-name`, `/mesh-broadcast`. Good for fan-out, research/build splits, orchestrator/worker setups.

Has its own [README](agent/extensions/pi-mesh/README.md) with protocol details and a [broadcast prompt plan](agent/extensions/pi-mesh/PLAN-broadcast-prompt.md) for a possible fan-out tool.

### [claude-code-provider](agent/extensions/claude-code-provider/)

The big one (~2k lines). Wraps the `claude` CLI so I can use Claude Code headless mode as a Pi model. Streams `stream-json` output, keeps Claude sessions alive across turns with `--resume`, renders Claude's internal tool calls as compact inline traces (not Pi toolCalls — wrong semantics here), handles `/compact` by summarizing and restarting the Claude session. Logs to `agent/debug.log`.

Docs next to the code:
- [BEHAVIOR.md](agent/extensions/claude-code-provider/BEHAVIOR.md) — streaming, compaction, usage tracking, context meter
- [INTEGRATION.md](agent/extensions/claude-code-provider/INTEGRATION.md) — why Claude tool events can't be Pi toolCalls
- [HEADLESS.md](agent/extensions/claude-code-provider/HEADLESS.md) — Claude Code headless CLI reference
- [TODO.md](agent/extensions/claude-code-provider/TODO.md) — what's left

### [claude-subagent](agent/extensions/claude-subagent/)

Registers a `claude_subagent` tool so any model running in Pi can shell out to Claude Code for a subtask. Thread-based session reuse, `/claude <task>` shortcut.


## Skills

### [chrome-cdp-win](agent/skills/chrome-cdp-win/)

Windows-only fork of `pi-chrome-cdp`. Same commands, but actually works on Windows — named pipes for daemon IPC, per-daemon marker files in `%TEMP%`, proper discovery and cleanup.

[SKILL.md](agent/skills/chrome-cdp-win/SKILL.md) for usage, [README.md](agent/skills/chrome-cdp-win/README.md) for the backstory.


## Other

- [docs/dead-key-bug.md](docs/dead-key-bug.md) — a dead key composition bug I hit in VSCode terminal (not tied to any extension)


## Setup

- **Claude extensions** — `claude` CLI on PATH (or set `CLAUDE_CLI_PATH`)
- **pi-mesh** — run `npm install` in [`agent/extensions/pi-mesh/`](agent/extensions/pi-mesh/)
- **chrome-cdp-win** — Windows, Node.js 22+, Chrome remote debugging enabled
