# Changelog

All notable changes to pi-dock are documented here.

This changelog is reconstructed from the git history from `2026-07-03` (first pi-dock commit)
through the present. pi-dock has never been published to npm: a version here names a state of
this checkout, dated by the day it was completed.

---

## Unreleased

### Breaking changes

- **`stop` prefixes its output with the agent name.** It prints `<name> stopped`,
  `<name> already stopped` or `<name> already failed`, one line per agent, so scripts can tell
  the results of a multi-name stop apart. (`a6c9baf`)

- **`ls` aligns its columns instead of separating them with tabs.** Like `models`, each column
  is as wide as its longest cell, with two spaces between columns and no trailing spaces.
  Scripts that split `ls` output on tabs must split on whitespace; agent names and model refs
  contain no spaces. (`808fbf0`)

- **An empty `--model` or `--thinking` is a usage error.** `spawn` and `set` used to treat
  `--model ''` or `--thinking ''` as absent, so an unset variable in a script silently fell back
  to Pi's default model, the default thinking level or the manifest's value. They now exit 1
  with `Option '--model' must not be empty` (or `--thinking`) and the usage line, before
  anything is launched or rewritten. To use the default, omit the option. (`ed86c78`)

- **Manifests without `model` or `flags` are no longer supported.** Only agents spawned before
  0.1.0 have them. A wake of such an agent no longer fails with
  `manifest model missing … set --model <provider/id> to repair`; delete the agent's
  `<name>.json` and `<name>.log` and spawn it again.

### Added

- **`pi-dock stop <name>...` stops several agents.** The whole list is checked first: an
  invalid, unknown or repeated name stops nothing. Then each agent is stopped in turn; a failure
  on one (not responding, did not exit within 5 s) is reported on stderr, the others are still
  stopped, and the exit code is 1. There is no `--all` and no pattern. (`a6c9baf`)

- **The log shows when extension messages enter an agent's context.** A new
  `external {id?, type}` event is logged whenever a custom extension message (for pi-link,
  type `link`) enters the session, with the id of the run it joins, if any; `logs` prints it as
  `external [id=…] type=link`. Only the type is logged; the content stays in the session file. It
  marks entry, not cause, and its absence proves nothing: extension prompts sent as user
  messages are not seen. (`2bf2947`)

- **README recipes for unattended teams.** A watchdog script stops an explicit roster at an
  absolute deadline, one name at a time, records each result and never kills a PID. An
  observer script waits for an agreed final marker, fresh per mission, as the last line of a
  `text` event from the lead, instead of trusting `done` or idle. Both are small Node scripts
  that run on Windows and Unix, and the skill points to them. (`9d934c1`)

### Changed

- **The skill states two facts from real use.** A `done` (or an idle agent) does not mean a
  team of agents has finished: extension callbacks such as pi-link replies can start later
  work, so a team's conclusion is an agreed signal in its `text`, and the artifact still needs
  checking. And `wait` or `send --wait` printing nothing means the run's last turn wrote no
  text; the earlier text is in `logs`. (`0e09f39`)

### Fixed

- **A wake never creates an agent.** If an agent's manifest disappeared before its runner
  started, the runner used to create a new agent, with a new session in the command's current
  directory. Now only `spawn` creates; a wake without a manifest logs `failed` with the
  missing file and exits, and the command reports the failed handshake. (`0e4a616`)

- **`stop` reports `already stopped|failed` only when nothing listens on the agent's pipe.**
  Before, any pipe error other than a timeout counted as already off, so a connection closed
  before the reply, or a reply that is not JSON, printed `<name> already failed` and exited 0
  while the agent could still be running. Those errors now fail that agent with
  `agent <name> <error>` on stderr, and `stop` exits 1. (`bd53b03`)

- **Concurrent wakes start one runner.** Two `start`s (or `send`s) at once could launch two
  runners for one agent: both opened the session and loaded its extensions (pi-link connected
  twice), and the second then logged `failed` with `EADDRINUSE` in the agent's log. Now a
  runner takes the agent's pipe before it opens the session or loads extensions, and a runner
  that finds the pipe taken exits without a trace. Requests that arrive while the agent is
  starting wait until it is ready. (`fee5903`)

- **`start` wakes only an agent that is off or shutting down.** It used to launch a runner on
  any pipe error other than a timeout and on any refusal, even with a runner still listening.
  Now it follows the same rule as `send` and `compact`: it wakes only when nothing listens or
  the runner answers `terminal`. A connection closed mid-request fails with
  `agent <name> stopped or crashed during status`, and any other refusal with
  `agent <name> refused status: <reply>`. (`27f51cf`)

- **`ls` and `show` report `not-responding` for an agent that does not answer in time.** They
  used to fall back to the log and show such an agent as `failed`, even if it was alive.
  `not-responding` says only that it did not answer within 200 ms; it is computed on each call
  and never logged. (`27f51cf`)

- **A compaction started by an extension shows as `compacting` and makes `compact` busy.**
  Only a compaction started with `pi-dock compact` used to count: during one an extension
  started (for example a remote compaction through pi-link), the agent showed as `idle`, and
  `pi-dock compact` was accepted and cancelled it. (`c3ed627`)

- **Errors thrown by extension handlers are logged.** Pi catches them and the agent keeps
  working, but nothing recorded them: an extension whose `session_start` threw left only
  `spawned` in the log. Each one is now logged as
  `extension_error {id?, extension, on, reason}`: the extension's file, the event its handler
  ran for, and the error message. Errors raised once the agent is stopping are not logged, so
  the terminal event stays last. (`f6ee480`)

- **A failed log write no longer stalls the prompt queue.** A failed write while a queued
  prompt or compaction ran could leave the runner alive with its queue stuck, so every later
  prompt waited forever without a report. The runner now fails: it logs `failed` if it still
  can, and exits either way. A prompt whose `queued` event cannot be written is refused with
  the error and is not queued; the agent stays usable. (`34871e5`)

- **A torn last log line no longer breaks `wait`.** If a write was cut short (power loss, full
  disk), the next wake appended its first event onto the fragment, and `wait` failed on the
  merged line from then on, even for earlier results. A wake now truncates the log to its
  last complete line first; the fragment is discarded. (`23447f3`)

---

## 0.2.0 — 2026-10-01

A usability release: prompts get ids and results you can wait for, argument validation is
stricter, and the operating instructions for AI agents ship as a Pi skill. Agents
created by 0.1.0 are not migrated: their manifest's `budget` field is ignored, and the next
`set` drops it.

### Breaking changes

- **The turn/time budget is gone; agents have no limits.** `--budget` on `spawn` and `set` is now
  an unknown option, a run is never stopped for running long, and `failed` with reason `budget`
  no longer happens. An agent runs until `stop` or a crash. (`6a85715`)

- **Arguments are strict.** Every command except `compact` rejects unknown options and extra
  arguments with its usage line instead of ignoring them; `--help`/`-h` reject extra arguments
  too. `send` now parses options, so prompt text that starts with `-` goes after `--`.
  `compact` still takes all remaining arguments as instructions. (`7d0df98`, `4b51331`,
  `2e6644f`)

- **`ls` prints `name state model age`.** The `turns`, `elapsed` and `session` columns are
  gone; age is the time since creation in its largest whole unit (`45s`, `12m`, `5h`, `43d`).
  The session file moved to `show`. (`7d0df98`, `d28c4cb`)

- **`logs` is readable by default.** Each event prints as `<ts> <event> key=value…`, with
  assistant text verbatim below it, instead of a JSON payload. `--raw` prints the stored NDJSON
  lines. (`d28c4cb`)

- **Log events changed.** A prompt now logs `queued {id}`, `run {id}`, `turn`/`text` with the
  id, and ends with `done {id}` (replacing `idle`) or `run_failed {id, reason}`. `turn` lost its
  `n` counter, `dropped` lists the lost prompt ids (`ids`) instead of a count, and
  `stopped`/`failed` carry the id of the run they interrupted. Work that extensions start while
  the agent is idle logs `turn`/`text` without an id. (`dc522b1`, `6a85715`)

- **Command output changed.** `send` prints the prompt id instead of `{"ok":true}`; `spawn` and
  `start` print `<name> <state> <provider/id>`; `set` no longer prints `budget=`. (`dc522b1`,
  `1b4a0b2`, `6a85715`)

- **Pipe replies changed.** `status` returns `{ok, state, model, pid}` (no `turns`), `prompt`
  returns `{ok, id}`, and `stop` returns `{ok, pid}`. This matters only to tools that talk to the
  pipe directly. (`1b4a0b2`, `dc522b1`, `fa99f13`)

### Added

- **`pi-dock models [filter]` lists the models you can use.** Only models with configured
  credentials appear, as `provider/id` with context, max-out, thinking and images columns. The
  `model … not found` error now points to it. (`1b4a0b2`)

- **`pi-dock show <name>` prints one agent's details.** Name, state, model, thinking, flags,
  cwd, session file and creation time, one key and value per line, without waking the agent.
  (`d28c4cb`)

- **Prompts have ids, and `pi-dock wait <name> <id>` waits for one.** `wait` prints the run's
  final text and exits 0 when it is done, or exits 1 with the reason when the run failed, the
  prompt was dropped, the agent stopped or crashed, or the id is unknown. It has no timeout and
  never wakes the agent; a run that already ended is reported at once. (`dc522b1`, `4b51331`)

- **`send --wait` and `send --file <path>`.** `--wait` sends and then waits: the id goes to
  stderr, so you can re-attach with `wait`, and only the final text goes to stdout. `--file`
  reads the prompt from a UTF-8 file. (`4b51331`)

- **A failed run no longer looks like success.** When a run's last turn ends in an unrecovered
  provider error or abort, the log says `run_failed` with the reason and `wait` exits 1. The
  agent stays on. (`dc522b1`)

- **The `compacting` state.** `ls`, `show` and `start` report `compacting` while a compaction
  runs. (`6ce3e23`)

- **`--thinking max`.** The thinking levels are now `off|minimal|low|medium|high|xhigh|max`.
  (`1b4a0b2`)

- **`logs --tail <n>`** prints only the last n events. (`d28c4cb`)

- **`pi-dock skill` and the pi-dock Pi skill.** The operating guide for AI agents (workflow,
  outcomes, recovery, warnings) moved out of `--help` into `skills/pi-dock/SKILL.md`, which
  `pi-dock skill` prints verbatim. pi-dock is now a Pi package exposing only that skill, so
  `pi install path/to/pi-dock` makes Pi agents load it when a task involves pi-dock. `--help`
  is a short human guide that points AI agents to it. (`e60bcf6`, `3c0b8f9`)

- **README.** Install steps, quick start, the commands, how resident agents work, recovery,
  data locations, and the trust and no-limits warnings. (`3c0b8f9`)

### Fixed

- **`stop` confirms the agent actually exited.** It prints `stopped` only once the runner process
  is gone; if it is still alive after 5 s, `stop` fails with
  `agent <name> did not exit within 5s; terminate PID <pid> externally`. Before, it reported
  `stopped` as soon as the runner acknowledged, so a `set` right after could find it still
  running. (`fa99f13`)

- **A stop or crash during `send` or `compact` is reported, not retried.** Before, a runner
  that closed mid-request was woken and sent the same request again. Now they wake the agent
  only when nothing is listening or the runner is shutting down, never on a mid-request close,
  which fails with `agent <name> stopped or crashed during <cmd>`. (`6ce3e23`)

- **`compact` waits for the real result.** It used to give up after 10 minutes and report the
  agent as not responding while the compaction went on. It now waits without a timeout (Ctrl-C
  only stops waiting), and a failed compaction is logged as `compact_failed` with its reason.
  (`6ce3e23`)

---

## 0.1.0 — 2026-10-01

The first complete pi-dock, developed from 2026-07-03. `package.json` called it `0.1.0-dev`.
This entry describes the code at `968f4f4`, the last code change before the 0.2.0 work. It
includes the move to Pi SDK 0.99.2 and the model suggestions from the same day: they predate
the 0.2.0 changes, and the paid end-to-end smoke test passed (69/69) on exactly this state.

### Commands

- **`spawn --name <name>`** creates an idle agent in the current directory and prints
  `<name> <state>`; it takes no prompt. Options: `--model <provider/id>`,
  `--thinking off|minimal|low|medium|high|xhigh`, `--budget <turns>[,<minutes>]|off` and
  repeatable `--x key[=value]`. (`094ce53`, `4db9c97`, `26bcfc9`)
- **`send <name> <text>`** delivers a prompt (the remaining arguments joined by spaces), wakes
  a stopped or failed agent first, and prints the pipe's reply, `{"ok":true}`. It never creates
  an agent. Replies appear as `text` events in the log. (`094ce53`)
- **`start <name>`** wakes an agent without a prompt; **`stop <name>`** powers it off and
  prints `stopped`, or `already stopped|failed`. (`094ce53`)
- **`ls`** prints `name state turns elapsed session`. States are `idle` and `running` while the
  runner answers, otherwise `stopped` or `failed` from the last complete log line. (`094ce53`)
- **`logs <name> [--follow]`** prints each event as `<ts> <event> {json}`. (`2b93a39`,
  `ab6668a`)
- **`set <name> [--model] [--thinking] [--budget] [--x ...]`** changes a powered-off agent's
  configuration for its next wake. (`4db9c97`, `26bcfc9`, `e34e8e4`)
- **`compact <name> [instructions]`** compacts an idle agent's session, waking it if needed,
  waits up to 10 minutes and prints `compacted`. (`4db9c97`)
- **`--help`/`-h`** (and bare `pi-dock`) prints usage and the resident workflow. (`26bcfc9`)

### Behavior

- **Resident agents.** Each agent is one detached runner process hosting one Pi session. It
  never exits because work finished, only on `stop`, a budget breach or a fatal error, and the
  next wake reopens the same session with its memory. There is no delete command. (`094ce53`)
- **Per-run budget, on by default.** Each prompt's run was limited to 20 turns and 30 minutes
  (`--budget <turns>[,<minutes>]`, or `off`). Exceeding it stopped the agent as
  `failed` with reason `budget`; the next `send` or `start` woke it. Work that extensions
  started while idle was not budgeted. (`094ce53`, `bf02f8e`, `26bcfc9`)
- **Preflight.** `spawn` and `set --model` check that the model exists and has credentials
  before creating or changing anything; an unknown model suggests up to five matching ones.
  (`fd437a0`, `968f4f4`)
- **Extension flags.** `--x key[=value]` passes opaque flags to the agent's extensions on every
  wake, so a docked agent can join pi-link with `--x link`. (`bf02f8e`)
- **Pi SDK 0.99.2.** pi-dock runs agents with its own `@earendil-works/pi-coding-agent`
  `^0.99.2` (previously `^0.80.3`). (`d865687`)
- **Data.** `~/.pi/dock/<name>.json` (manifest), `<name>.log` (NDJSON events: `spawned`,
  `turn {n}`, `text`, `idle`, `compacted`, `dropped {n}`, `stopped`, `failed {reason}`) and a
  named pipe (`\\.\pipe\pi-dock-<name>`, or a Unix socket in `~/.pi/dock`). (`3296490`,
  `094ce53`, `d2b4d76`)

### Hardening before 0.1.0

- **Race-safe creation.** Concurrent `spawn`s of one name produce exactly one agent; the others
  report `agent already exists`. (`1e4e2b4`)
- **Complete UTF-8 log records.** `logs --follow` and state derivation read only complete lines,
  so a half-written multibyte event is never printed or misread. (`ab6668a`)
- **`set` only on a confirmed powered-off agent.** A live, unresponsive or uncertain agent is
  refused. (`e34e8e4`)
- **Portable names.** Names are lowercase `a-z0-9` segments joined by `.`, `_` or `-`, at most
  64 characters, never a Windows device name, and are validated before any file or pipe access.
  (`507f157`)
- **The manifest's `provider/id` model is the only wake authority.** (`e0a1654`)
- **Unix stale sockets** left by a crashed runner are detected and replaced. (`d2b4d76`)
