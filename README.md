# .pi

My personal [Pi](http://pi.dev) config. Scrappy, opinionated, not meant for anyone else.

## Extensions

### [claude-code-provider](agent/extensions/claude-code-provider/)

The big one (~2k lines). Wraps the `claude` CLI so I can use Claude Code headless mode as a Pi model. Streams `stream-json` output, keeps Claude sessions alive across turns with `--resume`, renders Claude's internal tool calls as compact inline traces (not Pi toolCalls — wrong semantics here), handles `/compact` by summarizing and restarting the Claude session. Logs to `agent/debug.log`.

Docs next to the code:

- [BEHAVIOR.md](agent/extensions/claude-code-provider/BEHAVIOR.md) — streaming, compaction, usage tracking, context meter
- [INTEGRATION.md](agent/extensions/claude-code-provider/INTEGRATION.md) — why Claude tool events can't be Pi toolCalls
- [HEADLESS.md](agent/extensions/claude-code-provider/HEADLESS.md) — Claude Code headless CLI reference
- [TODO.md](agent/extensions/claude-code-provider/TODO.md) — what's left
- [REVIEW.md](agent/extensions/claude-code-provider/REVIEW.md) — code review notes

### [claude-subagent](agent/extensions/claude-subagent/)

Registers a `claude_subagent` tool so any model running in Pi can shell out to Claude Code for a subtask. Thread-based session reuse, `/claude <task>` shortcut.

### [pi-rules](agent/extensions/pi-rules.ts)

Branch-local prompt guidance. `/rules <text>` injects instructions into every LLM turn on the current branch. Supports loading from files (`/rules @file`), persists across session resume, and shows a footer widget when active. See [pi-rules-review.md](agent/extensions/pi-rules-review.md) for the code review.

### [uppercase-pi](agent/extensions/uppercase-pi/)

Tiny cosmetic extension. Rewrites standalone "pi" → "PI" in the system prompt right before it hits the provider. Runs in `before_provider_request` so it catches everything — built-in prompt, SYSTEM.md, append flags, other extensions. Skips code spans and identifier-like contexts (`pi.on`, `.pi/`, `pi-coding-agent`).

Has its own [test suite](agent/extensions/uppercase-pi/test.mjs) (`node test.mjs`).

## Workshop

### [pi-link](agent/workshop/pi-link/)

Published as `npm:pi-link`. Local WebSocket network between Pi terminals — hub-spoke on `localhost:9900`, auto-discovery, `link_send` / `link_prompt` / `link_list` tools, `/link` commands. The evolution of the earlier `pi-mesh` prototype. Lives in `workshop/` because it's an npm package with its own release cycle.

Has a thorough [README](agent/workshop/pi-link/README.md), a bundled `pi-link-coordination` skill, and various design docs (`PLAN-*.md`, `REPORT-*.md`, `STYLE.md`).

## Skills

### [chrome-cdp-win](agent/skills/chrome-cdp-win/)

Windows-only fork of `pi-chrome-cdp`. Same commands, but actually works on Windows — named pipes for daemon IPC, per-daemon marker files in `%TEMP%`, proper discovery and cleanup.

[SKILL.md](agent/skills/chrome-cdp-win/SKILL.md) for usage, [README.md](agent/skills/chrome-cdp-win/README.md) for the backstory.

## Other

- [docs/dead-key-bug.md](docs/dead-key-bug.md) — a dead key composition bug I hit in VSCode terminal

## Setup

- **Claude extensions** — `claude` CLI on PATH (or set `CLAUDE_CLI_PATH`)
- **pi-link** — `pi install npm:pi-link`
- **chrome-cdp-win** — Windows, Node.js 22+, Chrome remote debugging enabled
