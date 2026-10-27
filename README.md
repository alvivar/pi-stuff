# .pi

My personal [Pi](https://pi.dev) configuration: scrappy and opinionated. This repository tracks local extensions, skills, prompt templates, workshop projects, and curated notes.

## Extensions

### [pi-rules](agent/extensions/pi-rules.ts)

Branch-local prompt guidance. `/rules <text>` appends instructions to the system prompt for each run on the current branch. Supports loading from files (`/rules @file`), persists across session resume and tree navigation, and displays the active guidance near the editor. `/rules` shows the current guidance; `/rules clear` removes it.

### [uppercase-pi](agent/extensions/uppercase-pi/)

Cosmetic extension. Rewrites standalone "pi" → "PI" in known system-instruction fields of the outbound provider payload through `before_provider_request`.

Test from the repository root: `node agent/extensions/uppercase-pi/test.mjs` ([suite](agent/extensions/uppercase-pi/test.mjs)).

## Workshop

### [pi-link](agent/workshop/pi-link/)

The [manifest](agent/workshop/pi-link/package.json) declares `pi-link` **0.6.0**. A local WebSocket network between Pi terminals: hub-spoke on `127.0.0.1:9900`, auto-discovery, `link_send`, `link_list`, and `link_compact` tools, plus `/link` commands. Requires stable Pi **0.84.2+**, as enforced by the [extension](agent/workshop/pi-link/index.ts).

Install the npm package for Pi with:

```sh
pi install npm:pi-link
```

Connect using `pi --link`, `pi --link-name <name>`, or `/link-connect`. Install the optional shell launcher separately for `pi-link <name>`:

```sh
npm i -g pi-link
```

The Pi install enables the extension and bundled skill; the global install puts the launcher on `PATH`. See the package [README](agent/workshop/pi-link/README.md), [CHANGELOG](agent/workshop/pi-link/CHANGELOG.md), and [pi-link-tools skill](agent/workshop/pi-link/skills/pi-link-tools/SKILL.md).

### [pi-dock](agent/workshop/pi-dock/)

The [manifest](agent/workshop/pi-dock/package.json) declares `pi-dock` **0.4.2**, Node.js **22.19+**, and an exact dependency on the Pi SDK **1.4.0**. Runs named Pi agents as detached resident processes. An agent retains its session after `stop`; `start` or `send` wakes it again.

The [CLI](agent/workshop/pi-dock/bin/pi-dock.mjs) provides `spawn`, `send`, `wait`, `start`, `stop`, `ls`, `show`, `logs`, `set`, `compact`, `models`, and `skill`. The package includes an operating skill. See the [README](agent/workshop/pi-dock/README.md) for installation and platform limits, [DESIGN.md](agent/workshop/pi-dock/DESIGN.md) for contracts, and [tests](agent/workshop/pi-dock/test/) for regression and paid smoke coverage.

Read the [operating skill](agent/workshop/pi-dock/skills/pi-dock/SKILL.md) before using the CLI.

## Skills

- [browser-use](agent/skills/browser-use/SKILL.md) — direct CDP browser interaction.
- [clipboard-copy](agent/skills/clipboard-copy/SKILL.md) — copies text using PowerShell on Windows or OSC 52 on Termux.
- [pi-link-goal-loop](agent/skills/pi-link-goal-loop/SKILL.md) — goal-driven implement → independent review → fix → commit orchestration with separate roles. Requires the [pi-link-tools skill](agent/workshop/pi-link/skills/pi-link-tools/SKILL.md) for transport mechanics.

The `pi-link-tools` and `pi-dock` skills are bundled with their workshop packages.

## Prompt templates

[agent/prompts/](agent/prompts/) contains Markdown templates exposed as slash commands. Examples:

- [/alone](agent/prompts/alone.md) — solo work with user-managed Git.
- [/pair](agent/prompts/pair.md) — coordinate with another agent, with one implementer and the other reviewing.
- [/goal](agent/prompts/goal.md) — invoke the goal-loop skill.
- [/review](agent/prompts/review.md) — report concrete review findings.
- [/research-prompt](agent/prompts/research-prompt.md) — prepare a self-contained prompt for an internet research agent.

The directory also includes decision, explanation, minimal-implementation, commit, and compaction prompts.

## Disabled skills

- [pi-link-implement-review-commit](agent/skills_disabled/pi-link-implement-review-commit/SKILL.md) — older plan-driven orchestration, retained with its [brief and ledger templates](agent/skills_disabled/pi-link-implement-review-commit/templates/).

## Documentation

| Document | Purpose |
| --- | --- |
| [dead-key-bug.md](docs/dead-key-bug.md) | VSCode terminal dead-key composition fix; also records the related bare-Fn glyph workaround. |
| [fn-key-glyph-bug.md](docs/fn-key-glyph-bug.md) | Focused workaround and verification for bare Fn / Private Use Area glyph input. |
| [pi-credential-loading.md](docs/pi-credential-loading.md) | Pi credential resolution order and secure credential-loading options. |

## Keybindings

[agent/keybindings.json](agent/keybindings.json) maps follow-up messages to `Alt+Enter`.

## README maintenance

Keep this inventory synchronized with the repository:

- Source checkout versions and requirements from `package.json` and implemented code; verify registry availability separately before claiming a release is published.
- Source commands and behavior from CLI help, tests, and implementation.
- Verify repository-relative links after edits.
- Distinguish local resources, disabled skills, and workshop packages.
- Treat plans and proposals as historical/design context.
