# Draft GitHub issue for earendil-works/pi-mono

Target repo: https://github.com/earendil-works/pi-mono
Suggested labels: enhancement, packages

---

## Title

`pi install` should help users discover CLI bins shipped by installed packages

## Body

### Context

Pi 0.75.0 ([#4587](https://github.com/earendil-works/pi/issues/4587)) moved user-scoped npm package installs from the global npm root to a private `~/.pi/agent/npm/` root, fixing permission errors with system-managed Node installs (Homebrew, asdf, mise, etc.). This is a clear win for security and install reliability.

Side effect: any Pi package that ships a CLI bin via the `bin` field in its `package.json` is now installed to `~/.pi/agent/npm/node_modules/.bin/`, which is not on user PATH. Before 0.75, those bins landed in the global npm bin directory (which is typically on PATH).

### Concrete impact

[pi-link](https://github.com/alvivar/pi-link) ships both a Pi extension (`index.ts`) and a shell launcher (`bin/pi-link.mjs`). The launcher is the most-used surface — users run `pi-link <name>` to resume named sessions across terminals. After upgrading to Pi 0.75, `pi-link` is no longer on PATH despite the package being correctly installed. Multiple users were blocked with no clear signal pointing at the cause.

This affects any future Pi package with a `bin` field, not just pi-link.

### Proposed fixes (ranked by effort/impact)

#### 1. (low effort, high discoverability) — Install-time notice for packages with `bin`

When `pi install npm:<pkg>` completes successfully and `package.json` declares a `bin` field, print to stderr:

```
Note: <pkg> ships a CLI launcher at:
  ~/.pi/agent/npm/node_modules/.bin/<bin-name>

This is not on your PATH. To use the launcher, either:
  - Run `npm i -g <pkg>` to install it globally, OR
  - Add `~/.pi/agent/npm/node_modules/.bin/` to your PATH.
```

This is non-invasive, doesn't modify user env, and makes the issue immediately discoverable instead of users hitting "command not found" with no context.

#### 2. (medium effort, idiomatic) — `pi exec <bin> [args...]` subcommand

Pi knows where its managed npm root is. A `pi exec` runner would let users invoke installed package bins via:

```
pi exec pi-link list
pi exec my-tool --foo bar
```

Modeled after `npx`/`pnpm exec`. Bypasses PATH entirely, works on every install method. Could even support tab-completion via `pi exec <Tab>` listing all bins.

#### 3. (higher effort, opt-in) — PATH integration on first install

When `pi install` runs and detects no PATH entry for `~/.pi/agent/npm/node_modules/.bin/`, offer to write a shell-rc snippet (`mise`/`pyenv` pattern):

```
~/.pi/agent/npm/node_modules/.bin/ is not on your PATH.
Add it now? (yes/no)
  yes → appends 'export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"' to ~/.bashrc / ~/.zshrc / PowerShell profile
  no  → continue with notice only
```

More invasive but solves the problem once per user. Not preferred — explicit user action is fine.

#### Not recommended

- **Auto-symlink package bins into `~/.pi/agent/bin/`** (where Pi puts `fd`/`rg`). That directory isn't auto-PATH'd either, so it doesn't actually solve the discoverability problem unless combined with fix #3.
- **Pi modifying PATH for spawned child processes only.** Doesn't help; the user launches `pi-link <name>` from OUTSIDE Pi.

### Strong recommendation

Ship fix #1 (install-time notice) immediately — it's a few lines of code in `pi install` and immediately closes the discoverability gap for affected users. Plan fix #2 (`pi exec`) for a follow-up release as the idiomatic long-term answer.

### Repro

```bash
# On Pi 0.75+
pi install npm:pi-link@beta
pi-link --help    # bash: pi-link: command not found
ls ~/.pi/agent/npm/node_modules/.bin/  # but the bin shim is here
```

### Workaround for affected users (already documented in pi-link 0.1.15-beta.1 CHANGELOG)

```sh
npm i -g pi-link@beta    # restores `pi-link` on PATH
```

### Related

- pi-link 0.1.15-beta.1 CHANGELOG entry documenting this and the dual-install workaround
- pi-mono#4587 (the install-location change this issue reports on)
