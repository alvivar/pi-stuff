# 🥧 .pi

My personal [Pi](https://pi.dev) configuration: scrappy and opinionated. This repository tracks local extensions, skills, prompt templates, workshop projects, and curated notes.

**Contents:** [Extensions](#-extensions) · [Workshop](#-workshop) · [Skills](#-skills) · [Prompt templates](#-prompt-templates) · [Archived skills](#-archived-skills) · [Documentation](#-documentation) · [Keybindings](#-keybindings) · [README maintenance](#-readme-maintenance)

---

## 🧩 Extensions

| Extension                                      | Purpose                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| [pi-rules](agent/extensions/pi-rules.ts)       | Branch-local prompt guidance.                                    |
| [uppercase-pi](agent/extensions/uppercase-pi/) | Rewrites standalone "pi" → "PI" in outbound system instructions. |

### [pi-rules](agent/extensions/pi-rules.ts)

`/rules <text>` appends instructions to the system prompt for each run on the current branch.

| Command         | Effect                         |
| --------------- | ------------------------------ |
| `/rules <text>` | Set the guidance.              |
| `/rules @file`  | Load the guidance from a file. |
| `/rules`        | Show the current guidance.     |
| `/rules clear`  | Remove the guidance.           |

Guidance persists across session resume and tree navigation, and the active text is displayed near the editor.

### [uppercase-pi](agent/extensions/uppercase-pi/)

Cosmetic extension. Rewrites standalone "pi" → "PI" in known system-instruction fields of the outbound provider payload through `before_provider_request`.

Run the [test suite](agent/extensions/uppercase-pi/test.mjs) from the repository root:

```sh
node agent/extensions/uppercase-pi/test.mjs
```

---

## 🛠️ Workshop

| Package                            | Version   | Purpose                                         |
| ---------------------------------- | --------- | ----------------------------------------------- |
| [pi-link](agent/workshop/pi-link/) | **0.6.0** | Local WebSocket network between Pi terminals.   |
| [pi-dock](agent/workshop/pi-dock/) | **0.4.2** | Named Pi agents as detached resident processes. |

Versions come from each package's `package.json`.

### [pi-link](agent/workshop/pi-link/)

Hub-spoke network on `127.0.0.1:9900` with auto-discovery, the `link_send`, `link_list`, and `link_compact` tools, and `/link` commands. Requires stable Pi **0.84.2+**, as enforced by the [extension](agent/workshop/pi-link/index.ts).

Install the npm package for Pi:

```sh
pi install npm:pi-link
```

Connect using `pi --link`, `pi --link-name <name>`, or `/link-connect`.

Install the optional shell launcher separately for `pi-link <name>`:

```sh
npm i -g pi-link
```

The Pi install enables the extension and bundled skill; the global install puts the launcher on `PATH`.

📖 [README](agent/workshop/pi-link/README.md) · [CHANGELOG](agent/workshop/pi-link/CHANGELOG.md) · [pi-link-tools skill](agent/workshop/pi-link/skills/pi-link-tools/SKILL.md)

### [pi-dock](agent/workshop/pi-dock/)

Requires Node.js **22.19+** and depends on Pi SDK **1.4.0**. An agent retains its session after `stop`; `start` or `send` wakes it again.

The [CLI](agent/workshop/pi-dock/bin/pi-dock.mjs) provides:

| Group      | Commands                        |
| ---------- | ------------------------------- |
| Lifecycle  | `spawn`, `start`, `stop`, `set` |
| Work       | `send`, `wait`, `compact`       |
| Inspection | `ls`, `show`, `logs`, `models`  |
| Guidance   | `skill`                         |

Read the [operating skill](agent/workshop/pi-dock/skills/pi-dock/SKILL.md) before using the CLI.

📖 [README](agent/workshop/pi-dock/README.md) (installation, platform limits) · [DESIGN.md](agent/workshop/pi-dock/DESIGN.md) (contracts) · [tests](agent/workshop/pi-dock/test/) (regression and paid smoke)

---

## 🎓 Skills

| Skill                                                        | Purpose                                                                                                                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [browser-use](agent/skills/browser-use/SKILL.md)             | Direct CDP browser interaction.                                                                                                                                                                                |
| [clipboard-copy](agent/skills/clipboard-copy/SKILL.md)       | Copies text using PowerShell on Windows or OSC 52 on Termux.                                                                                                                                                   |
| [pi-link-goal-loop](agent/skills/pi-link-goal-loop/SKILL.md) | Goal-driven implement → independent review → fix → commit orchestration with separate roles. Requires the [pi-link-tools skill](agent/workshop/pi-link/skills/pi-link-tools/SKILL.md) for transport mechanics. |

The `pi-link-tools` and `pi-dock` skills are bundled with their workshop packages.

---

## 💬 Prompt templates

[agent/prompts/](agent/prompts/) contains Markdown templates exposed as slash commands.

| Command                                              | Purpose                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| [/alone](agent/prompts/alone.md)                     | Solo work with user-managed Git.                                  |
| [/pair](agent/prompts/pair.md)                       | Coordinate with another agent: one implements, the other reviews. |
| [/goal](agent/prompts/goal.md)                       | Invoke the goal-loop skill.                                       |
| [/review](agent/prompts/review.md)                   | Report concrete review findings.                                  |
| [/research-prompt](agent/prompts/research-prompt.md) | Prepare a self-contained prompt for an internet research agent.   |

The directory also includes decision, explanation, minimal-implementation, commit, and compaction prompts.

---

## 🗄️ Archived skills

| Skill                                                                                             | Purpose                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [pi-link-implement-review-commit](agent/skills_archived/pi-link-implement-review-commit/SKILL.md) | Older plan-driven orchestration, retained with its [brief and ledger templates](agent/skills_archived/pi-link-implement-review-commit/templates/). |

---

## 📚 Documentation

| Document                                                  | Purpose                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [dead-key-bug.md](docs/dead-key-bug.md)                   | VSCode terminal dead-key composition fix; also records the related bare-Fn glyph workaround. |
| [fn-key-glyph-bug.md](docs/fn-key-glyph-bug.md)           | Focused workaround and verification for bare Fn / Private Use Area glyph input.              |
| [pi-credential-loading.md](docs/pi-credential-loading.md) | Pi credential resolution order and secure credential-loading options.                        |

---

## ⌨️ Keybindings

[agent/keybindings.json](agent/keybindings.json) maps follow-up messages to `Alt+Enter`.
