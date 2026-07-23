# .pi

My personal [Pi](https://pi.dev) configuration: scrappy, opinionated, and not intended as a reusable setup. This repository tracks extensions, skills, workshop projects, MCP configuration, and curated notes; credentials, sessions, dependencies, caches, logs, and other runtime state are intentionally ignored.

## Overview

| Component | Status | Purpose |
| --- | --- | --- |
| [Claude Code provider](agent/extensions/claude-code-provider/) | Active extension | Uses the Claude CLI as a Pi model provider. |
| [Claude subagent](agent/extensions/claude-subagent/) | Active extension | Delegates subtasks to Claude Code. |
| [pi-rules](agent/extensions/pi-rules.ts) | Active extension | Adds branch-local prompt guidance. |
| [uppercase-pi](agent/extensions/uppercase-pi/) | Active extension | Uppercases standalone “pi” in outbound system instructions. |
| [pi-link](agent/workshop/pi-link/) | Published package | Coordinates local Pi terminals. |
| [pi-dock](agent/workshop/pi-dock/) | Local pre-release | Runs named, resident Pi agents. |
| [implement-review-commit](agent/skills/pi-link-implement-review-commit/) | Active skill | Provides a plan-driven multi-terminal delivery workflow. |
| [chrome-cdp-win](agent/skills_disabled/chrome-cdp-win/) | Disabled skill | Retains Windows Chrome CDP tooling for reference. |

## Extensions

### [claude-code-provider](agent/extensions/claude-code-provider/)

Wraps the `claude` CLI so I can use Claude Code headless mode as a Pi model. It streams responses, resumes Claude sessions across turns, displays Claude's internal tool activity as compact traces, and handles `/compact` by summarizing and restarting the Claude session.

Docs next to the code:

- [BEHAVIOR.md](agent/extensions/claude-code-provider/BEHAVIOR.md) — streaming, compaction, usage tracking, context meter
- [INTEGRATION.md](agent/extensions/claude-code-provider/INTEGRATION.md) — why Claude tool events can't be Pi toolCalls
- [HEADLESS.md](agent/extensions/claude-code-provider/HEADLESS.md) — Claude Code headless CLI reference
- [TODO.md](agent/extensions/claude-code-provider/TODO.md) — what's left
- [REVIEW.md](agent/extensions/claude-code-provider/REVIEW.md) — code review notes

### [claude-subagent](agent/extensions/claude-subagent/)

Registers a `claude_subagent` tool so any Pi model can delegate a subtask to Claude Code. It supports structured or streaming output, tool allowlists, timeouts, custom working directories, explicit session IDs, and automatic per-thread reuse. `/claude <task>` is a shortcut for invoking it.

### [pi-rules](agent/extensions/pi-rules.ts)

Branch-local prompt guidance. `/rules <text>` injects instructions into every LLM turn on the current branch. Supports loading from files (`/rules @file`), persists across session resume, and shows a footer widget when active.

### [uppercase-pi](agent/extensions/uppercase-pi/)

Tiny cosmetic extension. Rewrites standalone "pi" → "PI" in the system prompt right before it hits the provider. Runs in `before_provider_request` so it catches everything — built-in prompt, SYSTEM.md, append flags, other extensions. Skips code spans and identifier-like contexts (`pi.on`, `.pi/`, `pi-coding-agent`).

Test: `node agent/extensions/uppercase-pi/test.mjs` ([suite](agent/extensions/uppercase-pi/test.mjs)).

## Workshop

### [pi-link](agent/workshop/pi-link/)

Published as [`pi-link` on npm](https://www.npmjs.com/package/pi-link) (currently `0.2.0`). A local WebSocket network between Pi terminals: hub-spoke on `127.0.0.1:9900`, auto-discovery, `link_send`, `link_prompt`, `link_list`, and `link_compact` tools, plus `/link` commands. Requires Pi 0.74+.

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

Private local pre-release (`0.1.0-dev`) for running named Pi agents as detached resident processes. An agent retains its Pi session and memory after `stop`; `start` or `send` wakes it again.

Commands: `spawn`, `send`, `start`, `stop`, `ls`, `logs`, `set`, and `compact`. See [PLAN.md](agent/workshop/pi-dock/PLAN.md) for design history and [tests](agent/workshop/pi-dock/test/) for regression and smoke coverage.

## Skills

### [pi-link-implement-review-commit](agent/skills/pi-link-implement-review-commit/)

Local, plan-driven implement → review → commit orchestration for multi-terminal Pi work. It coordinates separate implementer, reviewer, and committer roles, requires task gates before review and commit, and keeps the orchestrator as the communication relay.

It is a policy skill built on `pi-link-coordination`, the general coordination skill bundled with `pi-link`.

## Disabled skills

### [chrome-cdp-win](agent/skills_disabled/chrome-cdp-win/)

Disabled Windows-only fork of `pi-chrome-cdp`, retained for reference. See [SKILL.md](agent/skills_disabled/chrome-cdp-win/SKILL.md) for usage and [README.md](agent/skills_disabled/chrome-cdp-win/README.md) for background.

## Documentation

| Document                                                  | Purpose                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [dead-key-bug.md](docs/dead-key-bug.md)                   | VSCode terminal dead-key composition fix; also records the related bare-Fn glyph workaround. |
| [fn-key-glyph-bug.md](docs/fn-key-glyph-bug.md)           | Focused workaround and verification for bare Fn / Private Use Area glyph input.              |
| [pi-credential-loading.md](docs/pi-credential-loading.md) | Pi credential resolution order and secure credential-loading options.                        |

## MCP

[agent/mcp.json](agent/mcp.json) configures the `chrome-devtools` MCP server via `chrome-devtools-mcp`.

## Prerequisites

The Claude integrations require the `claude` CLI on `PATH` or configured through `CLAUDE_CLI_PATH`.

## README maintenance

Keep this inventory synchronized with the repository:

- Source package versions and publish status from `package.json`.
- Source commands and behavior from CLI help, tests, and implemented code.
- Verify repository-relative links after edits.
- Mark disabled or pre-release components explicitly.
- Treat plans and proposals as historical/design context, not as the authority for current behavior.
