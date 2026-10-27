# .pi

My personal [Pi](https://pi.dev) configuration: scrappy, opinionated, and not intended as a reusable setup. This repository tracks local extensions, skills, prompt templates, workshop projects, and curated notes. Machine-specific settings, MCP configuration, credentials, sessions, installed packages, and other runtime state are excluded by [.gitignore](.gitignore).

## Overview

| Component | Location / status | Purpose |
| --- | --- | --- |
| [pi-rules](agent/extensions/pi-rules.ts) | Local extension | Adds branch-local prompt guidance. |
| [uppercase-pi](agent/extensions/uppercase-pi/) | Local extension | Uppercases standalone “pi” in outbound system instructions. |
| [pi-sub](agent/workshop/pi-sub/) | Workshop package; inactive copy under `agent/extensions/` | Shows Codex and OpenCode Go subscription quota. |
| [pi-link](agent/workshop/pi-link/) | Workshop package | Coordinates local Pi terminals. |
| [pi-dock](agent/workshop/pi-dock/) | Workshop package | Runs named, resident Pi agents. |
| [browser-use](agent/skills/browser-use/SKILL.md) | Local skill | Controls a browser via CDP, with a local no-vendor-cloud policy. |
| [clipboard-copy](agent/skills/clipboard-copy/SKILL.md) | Local skill | Copies text on request on Windows or Termux. |
| [pi-link-goal-loop](agent/skills/pi-link-goal-loop/SKILL.md) | Local skill | Provides goal-driven implement → review → fix → commit orchestration. |
| [Prompt templates](agent/prompts/) | Local prompts | Reusable slash-command workflows. |
| [Disabled skills](agent/skills_disabled/) | Not auto-discovered from this directory | Retains the older plan-driven workflow and Windows CDP tooling. |

“Local” describes files in Pi's conventional user resource directories, not a runtime verification. Workshop source is separate from installed npm packages; versions below describe the checked-in manifests, not a verified npm release or the version currently loaded by Pi.

## Extensions

### [pi-rules](agent/extensions/pi-rules.ts)

Branch-local prompt guidance. `/rules <text>` appends instructions to the system prompt for each run on the current branch. Supports loading from files (`/rules @file`), persists across session resume and tree navigation, and displays the active guidance near the editor. `/rules` shows the current guidance; `/rules clear` removes it. Rules are prompt guidance, not an enforcement mechanism.

### [uppercase-pi](agent/extensions/uppercase-pi/)

Cosmetic extension. Rewrites standalone "pi" → "PI" in known system-instruction fields of the outbound provider payload through `before_provider_request`. Skips Markdown code spans and identifier-like contexts (`pi.on`, `.pi/`, `pi-coding-agent`); leaves user, assistant, and tool messages untouched.

Test from the repository root: `node agent/extensions/uppercase-pi/test.mjs` ([suite](agent/extensions/uppercase-pi/test.mjs)).

### [pi-sub copy](agent/extensions/pi-sub/)

A copy of the [workshop implementation](agent/workshop/pi-sub/), but its top-level entry point is named [`index.ts.txt`](agent/extensions/pi-sub/index.ts.txt). Pi's automatic directory discovery expects `index.ts` or `index.js`, so this copy is not auto-loaded. The nested [`extensions/index.ts`](agent/extensions/pi-sub/extensions/index.ts) is the implementation entry point, not evidence that this directory is enabled.

## Workshop

### [pi-link](agent/workshop/pi-link/)

The [manifest](agent/workshop/pi-link/package.json) declares `pi-link` **0.6.0**. A local WebSocket network between Pi terminals: hub-spoke on `127.0.0.1:9900`, auto-discovery, `link_send`, `link_list`, and `link_compact` tools, plus `/link` commands. Requires stable Pi **0.84.2+**, as enforced by the [extension](agent/workshop/pi-link/index.ts).

Install the npm package for Pi with:

```sh
pi install npm:pi-link
```

Link is off by default in a fresh session; use `pi --link`, `pi --link-name <name>`, or `/link-connect`. Install the optional shell launcher separately for `pi-link <name>`:

```sh
npm i -g pi-link
```

The Pi install enables the extension and bundled skill; the global install puts the launcher on `PATH`. See the package [README](agent/workshop/pi-link/README.md), [CHANGELOG](agent/workshop/pi-link/CHANGELOG.md), and [pi-link-tools skill](agent/workshop/pi-link/skills/pi-link-tools/SKILL.md).

### [pi-dock](agent/workshop/pi-dock/)

The [manifest](agent/workshop/pi-dock/package.json) declares `pi-dock` **0.4.2**, Node.js **22.19+**, and an exact dependency on the Pi SDK **1.4.0**. Runs named Pi agents as detached resident processes. An agent retains its session after `stop`; `start` or `send` wakes it again.

The [CLI](agent/workshop/pi-dock/bin/pi-dock.mjs) provides `spawn`, `send`, `wait`, `start`, `stop`, `ls`, `show`, `logs`, `set`, `compact`, `models`, and `skill`. The package includes an operating skill, not a Pi extension. See the [README](agent/workshop/pi-dock/README.md) for installation and platform limits, [DESIGN.md](agent/workshop/pi-dock/DESIGN.md) for contracts, and [tests](agent/workshop/pi-dock/test/) for regression and paid smoke coverage.

Use only trusted working directories: docked agents bypass Pi's project-trust prompt, and there is no built-in turn, time, or cost cap. Read the [operating skill](agent/workshop/pi-dock/skills/pi-dock/SKILL.md) before using the CLI.

### [pi-sub](agent/workshop/pi-sub/)

The [manifest](agent/workshop/pi-sub/package.json) declares `pi-sub` **0.1.0** and Node.js **22.19+**. Shows remaining subscription quota and reset times for `openai-codex` and `opencode-go` in Pi's TUI footer. `/sub` displays the last result locally; `/sub refresh` requests an update. It resolves credentials through Pi and does no polling in non-TUI modes.

The [README](agent/workshop/pi-sub/README.md) documents endpoints, privacy, failure behavior, proposed installation, and development checks (`npm test`, `npm run typecheck`). Do not load it alongside `@bacnh85/pi-sub`: both register `/sub` and a footer segment. The workshop directory alone does not enable the package.

## Skills

- [browser-use](agent/skills/browser-use/SKILL.md) — direct CDP browser interaction. Its local policy prohibits Browser Use / PostHog cloud services, telemetry, vendor data sharing, and automatic self-updates; user-selected non-vendor CDP endpoints remain allowed. The external `browser-use` harness is required; this repository does not bundle it.
- [clipboard-copy](agent/skills/clipboard-copy/SKILL.md) — copies only when requested, using PowerShell on Windows or OSC 52 on Termux. Does not read the clipboard or claim the resulting clipboard content was verified.
- [pi-link-goal-loop](agent/skills/pi-link-goal-loop/SKILL.md) — goal-driven implement → independent review → fix → commit orchestration with separate roles. Requires the [pi-link-tools skill](agent/workshop/pi-link/skills/pi-link-tools/SKILL.md) for transport mechanics.

The `pi-link-tools` and `pi-dock` skills are bundled with their workshop packages, not duplicated under `agent/skills/`.

## Prompt templates

[agent/prompts/](agent/prompts/) contains Markdown templates exposed as slash commands. Examples:

- [/alone](agent/prompts/alone.md) — work without other agents and leave Git to the user.
- [/pair](agent/prompts/pair.md) — coordinate with another agent, with one implementer and the other reviewing.
- [/goal](agent/prompts/goal.md) — invoke the goal-loop skill.
- [/review](agent/prompts/review.md) — report concrete findings without modifying files or initiating orchestration.
- [/research-prompt](agent/prompts/research-prompt.md) — prepare a self-contained prompt for an internet research agent.

The directory also includes decision, explanation, minimal-implementation, commit, and compaction prompts. Review a template before invoking it: not all workflows authorize the same actions.

## Disabled skills

- [pi-link-implement-review-commit](agent/skills_disabled/pi-link-implement-review-commit/SKILL.md) — older plan-driven orchestration, retained with its [brief and ledger templates](agent/skills_disabled/pi-link-implement-review-commit/templates/).
- [chrome-cdp-win](agent/skills_disabled/chrome-cdp-win/) — Windows-only fork of `pi-chrome-cdp`, retained for reference. See its [README](agent/skills_disabled/chrome-cdp-win/README.md) and [SKILL.md](agent/skills_disabled/chrome-cdp-win/SKILL.md).

## Documentation

| Document | Purpose |
| --- | --- |
| [dead-key-bug.md](docs/dead-key-bug.md) | VSCode terminal dead-key composition fix; also records the related bare-Fn glyph workaround. |
| [fn-key-glyph-bug.md](docs/fn-key-glyph-bug.md) | Focused workaround and verification for bare Fn / Private Use Area glyph input. |
| [pi-credential-loading.md](docs/pi-credential-loading.md) | Pi credential resolution order and secure credential-loading options. |

## Local configuration and prerequisites

This checkout is not a reproducible Pi installation. `agent/settings.json` (including package declarations), `agent/mcp.json`, `agent/auth.json`, installed dependencies under `agent/npm/`, Pi releases under `agent/install/`, sessions, and dock runtime data are ignored by [.gitignore](.gitignore). Cloning the repository does not restore those files or configure an MCP server. The tracked [keybindings](agent/keybindings.json) map follow-up messages to `Alt+Enter`.

Use an installed Pi and satisfy each component's own prerequisites before enabling it. There is no root package manifest or repository-wide install/test command; workshop packages have their own manifests and checks.

## README maintenance

Keep this inventory synchronized with the repository:

- Source checkout versions and requirements from `package.json` and implemented code; verify registry availability separately before claiming a release is published.
- Source commands and behavior from CLI help, tests, and implementation.
- Verify repository-relative links after edits.
- Distinguish auto-discovered resources, disabled copies, workshop source, and locally installed packages.
- Do not present ignored machine configuration as part of the clone.
- Treat plans and proposals as historical/design context, not as the authority for current behavior.
