# .pi

My personal [Pi](http://pi.dev) config. Scrappy, opinionated, not meant for anyone else.

## Overview

| Component               | Status            | Purpose                                                     | Location                                        |
| ----------------------- | ----------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| Claude Code provider    | Active extension  | Uses the Claude CLI as a Pi model provider.                 | `agent/extensions/claude-code-provider/`        |
| Claude subagent         | Active extension  | Delegates subtasks to Claude Code.                          | `agent/extensions/claude-subagent/`             |
| pi-rules                | Active extension  | Adds branch-local prompt guidance.                          | `agent/extensions/pi-rules.ts`                  |
| uppercase-pi            | Active extension  | Uppercases standalone “pi” in outbound system instructions. | `agent/extensions/uppercase-pi/`                |
| pi-link                 | Published package | Local multi-terminal Pi coordination.                       | `agent/workshop/pi-link/`                       |
| pi-dock                 | Local pre-release | Runs named, resident Pi agents.                             | `agent/workshop/pi-dock/`                       |
| implement-review-commit | Active skill      | Plan-driven multi-terminal delivery workflow.               | `agent/skills/pi-link-implement-review-commit/` |
| chrome-cdp-win          | Disabled skill    | Windows Chrome CDP tooling retained for reference.          | `agent/skills_disabled/chrome-cdp-win/`         |

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

Registers a `claude_subagent` tool so any model running in Pi can shell out to Claude Code for a subtask. Supports JSON or streaming output, configurable tool allowlists, timeouts, and working directories, plus explicit session reuse or thread-based session reuse. `/claude <task>` is a shortcut for invoking it.

### [pi-rules](agent/extensions/pi-rules.ts)

Branch-local prompt guidance. `/rules <text>` injects instructions into every LLM turn on the current branch. Supports loading from files (`/rules @file`), persists across session resume, and shows a footer widget when active.

### [uppercase-pi](agent/extensions/uppercase-pi/)

Tiny cosmetic extension. Rewrites standalone "pi" → "PI" in the system prompt right before it hits the provider. Runs in `before_provider_request` so it catches everything — built-in prompt, SYSTEM.md, append flags, other extensions. Skips code spans and identifier-like contexts (`pi.on`, `.pi/`, `pi-coding-agent`).

Has its own [test suite](agent/extensions/uppercase-pi/test.mjs):

```sh
node agent/extensions/uppercase-pi/test.mjs
```

## Workshop

### [pi-link](agent/workshop/pi-link/)

Published as [`pi-link` on npm](https://www.npmjs.com/package/pi-link) (currently `0.2.0`). A local WebSocket network between Pi terminals: hub-spoke on `127.0.0.1:9900`, auto-discovery, `link_send`, `link_prompt`, `link_list`, and `link_compact` tools, plus `/link` commands. It evolved from the earlier `pi-mesh` prototype.

Install the Pi extension with:

```sh
pi install npm:pi-link
```

On Pi 0.75+, install the shell launcher separately if you want to run `pi-link <name>` from a terminal:

```sh
npm i -g pi-link
```

The global install is optional; the Pi install enables the extension, slash commands, and LLM tools. See the package [README](agent/workshop/pi-link/README.md), [CHANGELOG](agent/workshop/pi-link/CHANGELOG.md), bundled `pi-link-coordination` skill, and design documents (`PLAN-*.md`, `REPORT-*.md`).

### [pi-dock](agent/workshop/pi-dock/)

Local, private pre-release project (`0.1.0-dev`) for running named Pi agents as detached resident processes. An agent keeps its Pi session and memory after `stop`; `start` or `send` wakes it again.

Commands: `spawn`, `send`, `start`, `stop`, `ls`, `logs`, `set`, and `compact`.

Not published or ready for installation. See [PLAN.md](agent/workshop/pi-dock/PLAN.md) for the ratified design and [tests](agent/workshop/pi-dock/test/) for the current regression and smoke coverage.

## Skills

### [pi-link-implement-review-commit](agent/skills/pi-link-implement-review-commit/)

Local, plan-driven implement → review → commit orchestration for multi-terminal Pi work. It coordinates separate implementer, reviewer, and committer roles, requires task gates before review and commit, and keeps the orchestrator as the communication relay.

It is a policy skill built on `pi-link-coordination`, the general coordination skill bundled with `pi-link`.

## Disabled skills

### [chrome-cdp-win](agent/skills_disabled/chrome-cdp-win/)

Windows-only fork of `pi-chrome-cdp`, retained here but currently disabled. It uses named pipes for daemon IPC, per-daemon marker files in `%TEMP%`, and proper discovery and cleanup.

[SKILL.md](agent/skills_disabled/chrome-cdp-win/SKILL.md) for usage, [README.md](agent/skills_disabled/chrome-cdp-win/README.md) for the backstory.

## Documentation

| Document                                                  | Purpose                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [dead-key-bug.md](docs/dead-key-bug.md)                   | VSCode terminal dead-key composition fix; also records the related bare-Fn glyph workaround. |
| [fn-key-glyph-bug.md](docs/fn-key-glyph-bug.md)           | Focused workaround and verification for bare Fn / Private Use Area glyph input.              |
| [pi-credential-loading.md](docs/pi-credential-loading.md) | Pi credential resolution order and secure credential-loading options.                        |

## MCP

[agent/mcp.json](agent/mcp.json) configures the `chrome-devtools` MCP server via `chrome-devtools-mcp`.

Credentials, MCP cache/onboarding data, sessions, and other local runtime state remain intentionally ignored and are not documented here.

## Scope

This is a personal Pi configuration. The repository tracks extensions, skills, workshop projects, MCP configuration, and curated notes. Credentials, sessions, installed packages, caches, logs, and other runtime state are intentionally ignored.

## Setup

### Pi and integrations

- **Pi** — Pi `0.74+` is required for `pi-link`.
- **Claude extensions** — install the `claude` CLI and put it on `PATH`, or set `CLAUDE_CLI_PATH`.
- **pi-link extension** — `pi install npm:pi-link`

### Optional tooling

- **pi-link shell launcher** — on Pi 0.75+, install `npm i -g pi-link` to use `pi-link <name>` from a terminal.
- **pi-dock** — a local pre-release workshop project; it is not published or installable yet.

## README maintenance

Keep this inventory synchronized with the repository:

- Source package versions and publish status from `package.json`.
- Source commands and behavior from CLI help, tests, and implemented code.
- Verify repository-relative links after edits.
- Mark disabled or pre-release components explicitly.
- Treat plans and proposals as historical/design context, not as the authority for current behavior.
